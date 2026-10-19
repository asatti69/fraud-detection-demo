"""Phase 1: train an autoencoder fraud scorer and measure it honestly.

Pipeline:
  1. Split data/creditcard.csv chronologically by Time (60% train / 20% validation / 20% test).
  2. Build features: V1-V28, log-scaled Amount, time-of-day (sin/cos). Fit the scaler on train only.
  3. Train an autoencoder on NORMAL training transactions only (labels never used as a training target).
  4. Fraud score = reconstruction error. Pick the alert threshold on the validation set only.
  5. Evaluate once on the test set -> artifacts/metrics.json.
  6. Export to ONNX with feature engineering + scaling baked in -> artifacts/fraud_autoencoder.onnx.
  7. Write data/replay.csv (all test fraud + a sample of test normals) for the live demo.

Run:  .venv/bin/python ml/train.py
"""

import json
import math
from pathlib import Path

import numpy as np
import onnx
import onnxruntime as ort
import pandas as pd
import torch
from sklearn.metrics import average_precision_score, roc_auc_score
from torch import nn

ROOT = Path(__file__).resolve().parent.parent
DATA = ROOT / "data" / "creditcard.csv"
ARTIFACTS = ROOT / "artifacts"
ONNX_PATH = ARTIFACTS / "fraud_autoencoder.onnx"
METRICS_PATH = ARTIFACTS / "metrics.json"
REPLAY_PATH = ROOT / "data" / "replay.csv"

SEED = 42
TRAIN_FRAC, VAL_FRAC = 0.60, 0.20  # test gets the remaining (latest) 20%
SECONDS_PER_DAY = 86400.0
REPLAY_NORMALS = 2000

V_COLS = [f"V{i}" for i in range(1, 29)]
RAW_COLS = ["Time", *V_COLS, "Amount"]  # model input order (CSV order minus Class)

# Alert-rate targets for the threshold sweep. Each threshold is derived from the
# VALIDATION score distribution, then applied unchanged to the test set.
SWEEP_ALERT_RATES = [0.0005, 0.001, 0.0015, 0.002, 0.003, 0.004, 0.005, 0.0075,
                     0.01, 0.015, 0.02, 0.03, 0.05, 0.075, 0.10]


def engineer(raw: np.ndarray) -> np.ndarray:
    """Raw [Time, V1..V28, Amount] -> [V1..V28, log1p(Amount), sin(day), cos(day)]."""
    t, v, amount = raw[:, 0], raw[:, 1:29], raw[:, 29]
    phase = 2 * math.pi * np.mod(t, SECONDS_PER_DAY) / SECONDS_PER_DAY
    return np.column_stack([v, np.log1p(amount), np.sin(phase), np.cos(phase)])


class Autoencoder(nn.Module):
    def __init__(self, n_features: int):
        super().__init__()
        self.encoder = nn.Sequential(nn.Linear(n_features, 16), nn.ReLU(), nn.Linear(16, 8), nn.ReLU())
        self.decoder = nn.Sequential(nn.Linear(8, 16), nn.ReLU(), nn.Linear(16, n_features))

    def forward(self, z):
        return self.decoder(self.encoder(z))


class FraudScorer(nn.Module):
    """Raw transaction -> fraud score. This is what gets exported to ONNX, so Java
    only has to send raw fields (Time, V1-V28, Amount) and gets a score back."""

    def __init__(self, ae: Autoencoder, mean: np.ndarray, scale: np.ndarray):
        super().__init__()
        self.ae = ae
        self.register_buffer("mean", torch.tensor(mean, dtype=torch.float32))
        self.register_buffer("scale", torch.tensor(scale, dtype=torch.float32))

    def forward(self, transactions):
        t = transactions[:, 0:1]
        v = transactions[:, 1:29]
        amount = transactions[:, 29:30]
        seconds_of_day = t - torch.floor(t / SECONDS_PER_DAY) * SECONDS_PER_DAY
        phase = 2 * math.pi * seconds_of_day / SECONDS_PER_DAY
        feats = torch.cat([v, torch.log(amount + 1.0), torch.sin(phase), torch.cos(phase)], dim=1)
        z = (feats - self.mean) / self.scale
        return torch.mean((self.ae(z) - z) ** 2, dim=1)


def evaluate(scores, labels, amounts, threshold):
    flagged = scores >= threshold
    fraud = labels == 1
    tp = int(np.sum(flagged & fraud))
    fp = int(np.sum(flagged & ~fraud))
    fn = int(np.sum(~flagged & fraud))
    tn = int(np.sum(~flagged & ~fraud))
    precision = tp / (tp + fp) if tp + fp else None
    recall = tp / (tp + fn) if tp + fn else None
    f1 = 2 * precision * recall / (precision + recall) if precision and recall else 0.0
    caught = float(amounts[flagged & fraud].sum())
    total = float(amounts[fraud].sum())
    return {
        "threshold": float(threshold),
        "recall": recall,
        "precision": precision,
        "f1": f1,
        "alert_rate": float(flagged.mean()),
        "alerts": int(flagged.sum()),
        "tp": tp, "fp": fp, "fn": fn, "tn": tn,
        "fraud_dollars_caught": round(caught, 2),
        "fraud_dollars_total": round(total, 2),
        "fraud_dollars_caught_pct": caught / total if total else None,
        "n_transactions": int(len(labels)),
    }


def main():
    np.random.seed(SEED)
    torch.manual_seed(SEED)
    torch.set_num_threads(1)  # deterministic CPU results
    ARTIFACTS.mkdir(exist_ok=True)

    # --- 1. Chronological split (data is already sorted by Time; we sort anyway) ---
    df = pd.read_csv(DATA).sort_values("Time", kind="stable").reset_index(drop=True)
    t_val = df["Time"].quantile(TRAIN_FRAC)
    t_test = df["Time"].quantile(TRAIN_FRAC + VAL_FRAC)
    splits = {
        "train": df[df["Time"] < t_val],
        "validation": df[(df["Time"] >= t_val) & (df["Time"] < t_test)],
        "test": df[df["Time"] >= t_test],
    }
    for name, s in splits.items():
        print(f"{name:>10}: {len(s):>7,} rows, {int(s.Class.sum()):>3} fraud "
              f"({s.Class.mean():.3%}), Time {s.Time.min():,.0f}-{s.Time.max():,.0f}s")

    raw = {k: s[RAW_COLS].to_numpy(np.float64) for k, s in splits.items()}
    labels = {k: s["Class"].to_numpy() for k, s in splits.items()}
    amounts = {k: s["Amount"].to_numpy() for k, s in splits.items()}

    # --- 2. Features; scaler fit on the training split only ---
    train_feats = engineer(raw["train"])
    mean = train_feats.mean(axis=0)
    scale = train_feats.std(axis=0)

    # --- 3. Train on normal training transactions only ---
    normal = (train_feats[labels["train"] == 0] - mean) / scale
    perm = np.random.permutation(len(normal))
    n_hold = len(normal) // 10  # 10% of train normals for early stopping (not the validation set)
    fit_x = torch.tensor(normal[perm[n_hold:]], dtype=torch.float32)
    hold_x = torch.tensor(normal[perm[:n_hold]], dtype=torch.float32)

    ae = Autoencoder(normal.shape[1])
    opt = torch.optim.Adam(ae.parameters(), lr=1e-3)
    loss_fn = nn.MSELoss()
    best_loss, best_state, patience, bad_epochs = float("inf"), None, 5, 0
    for epoch in range(1, 201):
        ae.train()
        order = torch.randperm(len(fit_x))
        for i in range(0, len(fit_x), 512):
            batch = fit_x[order[i:i + 512]]
            opt.zero_grad()
            loss = loss_fn(ae(batch), batch)
            loss.backward()
            opt.step()
        ae.eval()
        with torch.no_grad():
            hold_loss = loss_fn(ae(hold_x), hold_x).item()
        print(f"epoch {epoch:>2}: holdout reconstruction MSE {hold_loss:.4f}")
        if hold_loss < best_loss - 1e-4:
            best_loss, best_state, bad_epochs = hold_loss, {k: v.clone() for k, v in ae.state_dict().items()}, 0
        else:
            bad_epochs += 1
            if bad_epochs >= patience:
                print(f"early stop: no improvement for {patience} epochs")
                break
    ae.load_state_dict(best_state)
    ae.eval()

    scorer = FraudScorer(ae, mean, scale).eval()
    torch.save(scorer.state_dict(), ARTIFACTS / "fraud_scorer.pt")

    # --- 6. Export to ONNX (raw features in, score out) and score everything with ONNX Runtime ---
    example = torch.tensor(raw["test"][:8], dtype=torch.float32)
    torch.onnx.export(
        scorer, (example,), str(ONNX_PATH),
        input_names=["transactions"], output_names=["score"],
        dynamic_shapes={"transactions": {0: torch.export.Dim("batch")}},
        dynamo=True, external_data=False,
    )
    model = onnx.load(str(ONNX_PATH))
    onnx.checker.check_model(model)
    session = ort.InferenceSession(str(ONNX_PATH), providers=["CPUExecutionProvider"])

    def onnx_scores(x):
        return session.run(["score"], {"transactions": x.astype(np.float32)})[0].astype(np.float64)

    scores = {k: onnx_scores(x) for k, x in raw.items()}
    with torch.no_grad():
        torch_test = scorer(torch.tensor(raw["test"], dtype=torch.float32)).numpy().astype(np.float64)
    abs_diff = np.abs(torch_test - scores["test"])
    parity = float(np.max(abs_diff))
    parity_rel = float(np.max(abs_diff / np.maximum(np.abs(torch_test), 1.0)))
    print(f"ONNX vs PyTorch on test set: max abs diff {parity:.2e}, max relative diff {parity_rel:.2e}")
    assert np.allclose(scores["test"], torch_test, rtol=1e-5, atol=1e-5), "ONNX export does not match PyTorch"

    # --- 4. Threshold: maximize F1 on the validation set only ---
    val_s, val_y, val_amt = scores["validation"], labels["validation"], amounts["validation"]
    candidates = np.unique(np.quantile(val_s, np.linspace(0.90, 0.99995, 4000)))
    val_results = [evaluate(val_s, val_y, val_amt, t) for t in candidates]
    best_val = max(val_results, key=lambda r: (r["f1"], -r["alert_rate"]))
    threshold = best_val["threshold"]

    # --- 5. Evaluate on the test set ---
    test_s, test_y, test_amt = scores["test"], labels["test"], amounts["test"]
    test_result = evaluate(test_s, test_y, test_amt, threshold)
    sweep = []
    for rate in SWEEP_ALERT_RATES:
        t = float(np.quantile(val_s, 1 - rate))
        sweep.append({"target_validation_alert_rate": rate,
                      "validation": evaluate(val_s, val_y, val_amt, t),
                      "test": evaluate(test_s, test_y, test_amt, t)})

    metrics = {
        "description": "Autoencoder fraud scorer. All 'test' numbers are on held-out data "
                       "(the latest 20% of transactions by time), never used for training or threshold choice.",
        "dataset": "Kaggle Credit Card Fraud Detection (creditcard.csv)",
        "split": {
            "method": "chronological by Time (no shuffling): first 60% train, next 20% validation, last 20% test",
            **{name: {"rows": int(len(s)), "fraud": int(s.Class.sum()),
                      "time_start_s": float(s.Time.min()), "time_end_s": float(s.Time.max())}
               for name, s in splits.items()},
        },
        "features": "V1-V28, log1p(Amount), sin/cos of (Time mod 24h); standardized with mean/std from the training split",
        "training": {
            "trained_on": "normal (Class 0) training transactions only",
            "rows": int(len(fit_x)), "early_stopping_holdout_rows": int(len(hold_x)),
            "best_holdout_mse": best_loss,
        },
        "score": "mean squared reconstruction error (higher = more unusual)",
        "threshold_rule": "maximize F1 on the validation set",
        "threshold": threshold,
        "validation_at_threshold": best_val,
        "test": test_result,
        "test_threshold_free": {
            "roc_auc": float(roc_auc_score(test_y, test_s)),
            "average_precision": float(average_precision_score(test_y, test_s)),
            "fraud_base_rate": float(test_y.mean()),
        },
        "threshold_sweep": sweep,
        "onnx": {"file": ONNX_PATH.name, "input": "transactions float32[N,30] = Time, V1..V28, Amount",
                 "output": "score float32[N]", "max_abs_diff_vs_pytorch": parity,
                 "max_relative_diff_vs_pytorch": parity_rel},
    }
    METRICS_PATH.write_text(json.dumps(metrics, indent=2))

    # --- 7. Replay file: every test fraud + a random sample of test normals, in time order ---
    test_df = splits["test"].assign(score=test_s, flagged=(test_s >= threshold).astype(int))
    normals = test_df[test_df.Class == 0].sample(REPLAY_NORMALS, random_state=SEED)
    replay = pd.concat([test_df[test_df.Class == 1], normals]).sort_values("Time", kind="stable")
    replay.to_csv(REPLAY_PATH, index=False, float_format="%.10g")

    # --- 8. Plain-English summary ---
    r = test_result
    print("\n" + "=" * 72)
    print(f"Threshold {threshold:.4f} chosen on validation (max F1).")
    print(f"On held-out test data ({r['n_transactions']:,} transactions, {r['tp'] + r['fn']} fraud), "
          f"it caught {r['recall']:.1%} of fraud cases ({r['tp']} of {r['tp'] + r['fn']}),")
    print(f"worth ${r['fraud_dollars_caught']:,.2f} of ${r['fraud_dollars_total']:,.2f} "
          f"({r['fraud_dollars_caught_pct']:.1%} of fraud dollars), "
          f"while flagging {r['alert_rate']:.2%} of transactions ({r['alerts']} alerts).")
    print(f"Precision: {r['precision']:.1%} of alerts were real fraud "
          f"(TP={r['tp']} FP={r['fp']} FN={r['fn']} TN={r['tn']}).")
    print(f"Wrote {METRICS_PATH.relative_to(ROOT)}, {ONNX_PATH.relative_to(ROOT)}, "
          f"{REPLAY_PATH.relative_to(ROOT)} ({len(replay):,} rows, {int(replay.Class.sum())} fraud)")


if __name__ == "__main__":
    main()
