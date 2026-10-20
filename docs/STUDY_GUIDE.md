# Study guide: card fraud detection demo

This guide is for understanding and defending every part of this project in a technical
interview. Each idea is explained in plain English first, then in more depth.

**Ground rules.** Every number here comes from a file in this repository
(`artifacts/metrics.json`, `data/replay.csv`, the code) or from a test or run recorded while
building the project. Where a number comes from a run rather than a file, the guide says so.
Where something is a judgment call or I'm not certain, the guide says that too.

**How to use it.** Read section 1, then one layer from section 2 at a time. Try the three
interview questions before reading the model answers. Finish with the self-quiz in section 6.

---

## Contents

1. [The big picture](#1-the-big-picture)
2. [Layer by layer](#2-layer-by-layer)
   - [2.1 Data and features](#21-data-and-features)
   - [2.2 The autoencoder](#22-the-autoencoder)
   - [2.3 Training](#23-training)
   - [2.4 Threshold choice](#24-threshold-choice)
   - [2.5 Evaluation and metrics](#25-evaluation-and-metrics)
   - [2.6 ONNX export](#26-onnx-export)
   - [2.7 The Java API](#27-the-java-api)
   - [2.8 The replay server](#28-the-replay-server)
   - [2.9 The dashboard](#29-the-dashboard)
   - [2.10 start.sh and reliability](#210-startsh-and-reliability)
   - [2.11 The sensitivity slider](#211-the-sensitivity-slider)
3. [Every number, explained](#3-every-number-explained)
4. [Known limitations and how to talk about them](#4-known-limitations-and-how-to-talk-about-them)
5. [Glossary](#5-glossary)
6. [Self-quiz (25 questions)](#6-self-quiz)

---

## 1. The big picture

**In one sentence:** a model learns what normal card transactions look like, a Java service
scores new transactions against that, and a dashboard shows the scores live next to honest
results measured on data the model never saw.

The project runs in **two separate stages**.

**Stage 1: prepare (once, before the demo).** One Python script reads the dataset and writes
three files. Python is not used during the demo.

```
 creditcard.csv ──► ml/train.py ──┬──► fraud_autoencoder.onnx   (the model)
 284,807 rows       learns and    ├──► metrics.json             (the held-out results)
                    tests, once   └──► replay.csv               (the demo stream)
```

**Stage 2: run the live demo.** Three programs run at once, and each one opens the files it needs.

```
 replay.csv                          fraud_autoencoder.onnx + metrics.json
     │                                            │
     ▼                                            ▼
 ┌────────────────┐   1 transaction ──►   ┌────────────────────┐
 │ Replay server  │                       │ Java API           │
 │ Node, :8081    │   ◄── score, alert?   │ Spring Boot, :8080 │
 └───────┬────────┘                       └────────────────────┘
         │ pushes each result (WebSocket)
         ▼
 ┌────────────────┐
 │ Dashboard      │   in your browser, :5173
 └────────────────┘
```

**One transaction's journey (three times a second):** the replay server takes the next row of
`replay.csv` → sends it to the Java API → the API scores it with the model and replies with the
score and whether it's an alert → the replay server pushes the result to the dashboard.

**The right-hand panel's numbers** take a different route: `metrics.json` → Java API
(`GET /metrics`) → replay server (passes it through) → dashboard. The dashboard only ever talks
to the replay server.

`start.sh` starts the three programs in order, waits for each health check, and restarts any
that crash.

| Piece | One sentence |
|---|---|
| `ml/train.py` | Trains the model on past normal transactions, picks the alert threshold on validation data, grades it once on the latest data, and exports everything. |
| `artifacts/metrics.json` | The held-out results: the single source for every performance number shown anywhere. |
| `artifacts/fraud_autoencoder.onnx` | The trained model plus its feature steps, in a standard file any language can run. |
| `data/replay.csv` | The demo stream: every test-set fraud plus 2,000 sampled normal test transactions. |
| Java API (`api/`) | A web service that scores one transaction at a time with the ONNX model. |
| Replay server (`replay/`) | Plays the demo stream through the API at a steady pace and pushes results to dashboards. |
| Dashboard (`dashboard/`) | Shows the live stream and the held-out results, clearly separated. |
| `start.sh` / `stop.sh` | Start everything with one command and keep it running; stop it cleanly. |

**The idea to carry through every answer: test the way it will be used.** In production a
model always scores transactions that happen *after* the ones it learned from. So the data is
split by time, decisions are made on validation data, and the test set is used once.

---

## 2. Layer by layer

### 2.1 Data and features

**Plain English.** The dataset is two days of real European card transactions. Before the
model sees them, the data is split into past, middle and latest periods, and each transaction
is turned into 31 numbers the model can compare fairly.

**What the data contains.** 284,807 transactions, 492 of them fraud (0.17%), over about 48
hours (`Time` runs from 0 to 172,792 seconds). Columns:
- `V1`–`V28`: anonymized features from a PCA transformation done by the dataset's publishers.
  Nobody outside the publishers knows what they mean.
- `Time`: seconds since the first transaction.
- `Amount`: dollars.
- `Class`: 1 for fraud, 0 for normal.

There are 1,081 exact duplicate rows (measured while checking the data in Phase 1).

**Key code: the chronological split** (`ml/train.py` lines 120–127)

```python
df = pd.read_csv(DATA).sort_values("Time", kind="stable").reset_index(drop=True)
t_val = df["Time"].quantile(TRAIN_FRAC)
t_test = df["Time"].quantile(TRAIN_FRAC + VAL_FRAC)
splits = {
    "train": df[df["Time"] < t_val],
    "validation": df[(df["Time"] >= t_val) & (df["Time"] < t_test)],
    "test": df[df["Time"] >= t_test],
}
```

`TRAIN_FRAC, VAL_FRAC = 0.60, 0.20` (line 35). The cut points are timestamps, so rows with the
same `Time` always land in the same split, and duplicates can't straddle a cut.

| Split | Rows | Fraud | Time range (s) |
|---|---|---|---|
| Train | 170,882 | 360 | 0 – 120,395 |
| Validation | 56,963 | 57 | 120,396 – 145,247 |
| Test | 56,962 | 75 | 145,248 – 172,792 |

**Key code: feature engineering** (`ml/train.py` lines 48–52)

```python
def engineer(raw: np.ndarray) -> np.ndarray:
    """Raw [Time, V1..V28, Amount] -> [V1..V28, log1p(Amount), sin(day), cos(day)]."""
    t, v, amount = raw[:, 0], raw[:, 1:29], raw[:, 29]
    phase = 2 * math.pi * np.mod(t, SECONDS_PER_DAY) / SECONDS_PER_DAY
    return np.column_stack([v, np.log1p(amount), np.sin(phase), np.cos(phase)])
```

That's 28 + 1 + 2 = **31 features**.

**Key code: scaling, fit on training data only** (`ml/train.py` lines 137–139)

```python
train_feats = engineer(raw["train"])
mean = train_feats.mean(axis=0)
scale = train_feats.std(axis=0)
```

**The theory.**

- **Chronological split.** A random split would mix future transactions into training. Fraud
  comes in bursts (one stolen card, many charges), so parts of the same burst would sit in
  both train and test, and the test would reward recognizing something partly seen. The 1,081
  duplicates would also land on both sides. A time split answers the question a bank asks:
  "how will this do next week?"
- **`log(1 + Amount)`.** Amounts are heavily skewed: the training median is $21.89, the mean
  $87.34 and the maximum $19,656.53, and 80.1% are under $100. Raw dollars would let a few huge
  purchases dominate the error. The log turns each 10× jump into an equal step of about 2.3
  ($10 → 2.40, $100 → 4.62, $1,000 → 6.91). The "1 +" handles $0 transactions, since log(0)
  is undefined.
- **Sine and cosine of time of day.** Time of day is circular: 11:59 pm and 12:01 am are two
  minutes apart, but as hours they're 23 and 0. Putting time on a circle (cos = horizontal,
  sin = vertical) keeps neighbors close. You need both, because one alone is ambiguous: 3 am
  and 9 am have the same sine.
- **Standardizing** (subtract the mean, divide by the standard deviation) puts every feature
  on a similar scale, so no feature dominates the error just because its numbers are bigger.
- **Fitting the scaler on training data only** prevents *leakage*: test-period statistics
  would otherwise seep into the inputs. In production, you can't compute statistics from data
  that hasn't arrived yet.

**Alternatives I didn't choose.**
- **Random or stratified split:** easier and inflates results (see above).
- **Walk-forward validation:** several train-then-test rounds moving forward in time. It's
  better, but with two days of data there's room for only one clean cut.
- **Robust scaling** (median and interquartile range instead of mean and std): more resistant
  to outliers. After the log transform, standard scaling was adequate. This is a judgment
  call, not something I tested.
- **Hour as a number 0–23:** simpler, but breaks at midnight.

**What would go wrong without it.** Random splitting gives optimistic numbers the bank would
never see. Raw amounts let big purchases dominate. A scaler fit on everything is a small but
real leak.

**Interview questions**

> **Q: Why split by time instead of randomly?**
> Because in production the model always scores transactions that happen after the ones it
> learned from, so I tested it the same way. A random split would inflate the results: fraud
> comes in bursts that would straddle train and test, and this dataset has 1,081 duplicate
> rows that would appear on both sides.

> **Q: Why fit the scaler only on training data? Wouldn't using everything be more accurate?**
> Using everything would leak information from the test period into the inputs. The effect
> here is small with 170,000 training rows, but it's the habit that prevents bigger leaks, and
> it matches deployment: those averages are frozen inside the model file.

> **Q: Why sine and cosine for time?**
> Time of day wraps around. As hours, 11:59 pm and 12:01 am are 23 and 0, maximally far apart.
> On a circle they're neighbors. Two coordinates are needed because one alone is ambiguous. One
> caveat: `Time` counts from the first transaction, so "time of day" assumes the data starts at
> midnight.

---

### 2.2 The autoencoder

**Plain English.** An autoencoder squeezes each transaction into a short summary and then
tries to rebuild it. Trained only on normal transactions, it gets good at rebuilding normal
ones and bad at rebuilding unusual ones. **How badly it rebuilds a transaction is the fraud score.**

**Key code** (`ml/train.py` lines 55–62)

```python
class Autoencoder(nn.Module):
    def __init__(self, n_features: int):
        super().__init__()
        self.encoder = nn.Sequential(nn.Linear(n_features, 16), nn.ReLU(), nn.Linear(16, 8), nn.ReLU())
        self.decoder = nn.Sequential(nn.Linear(8, 16), nn.ReLU(), nn.Linear(16, n_features))

    def forward(self, z):
        return self.decoder(self.encoder(z))
```

Shape: **31 → 16 → 8 → 16 → 31**, with **1,319** learned parameters (counted from
`artifacts/fraud_scorer.pt`).

**The score** (`ml/train.py` line 83): the mean squared difference between the scaled input
and its rebuild, averaged over the 31 features.

```python
return torch.mean((self.ae(z) - z) ** 2, dim=1)
```

**The theory.**
- **The bottleneck (8 numbers) is the point.** If the middle had 31 or more slots, the network
  could copy its input straight through and rebuild everything perfectly, fraud included. Every
  score would be near zero. Squeezing to 8 forces it to learn the *patterns* of normal behavior,
  meaning which features move together.
- **ReLU** (rectified linear unit: output = max(0, x)) lets the network learn non-linear
  patterns. The last layer has no activation, because the rebuilt features can be negative.
- **Mean squared error** punishes big misses more than small ones and is always positive. The
  same quantity is the training goal (minimize it on normal data) and the score (measure it on
  new data).
- **Why an autoencoder for fraud:** it needs no fraud labels to train. That matters because
  fraud is rare, labels arrive late (chargebacks), and new fraud patterns have no labels yet.

**Alternatives I didn't choose.**
- **Supervised classifier** (e.g. gradient boosting) trained on fraud labels: usually much
  stronger on *known* fraud patterns, but needs labels and can miss new schemes. In a real bank
  I'd run one alongside this model.
- **Isolation Forest or one-class SVM:** other unsupervised anomaly detectors. I didn't compare
  them, so I can't say whether they'd do better here.
- **A bigger or deeper autoencoder:** the sizes are a reasonable small default, not tuned.
  Tuning them on validation data is a natural next step.

**What would go wrong without the bottleneck.** No bottleneck means a perfect copier: every
score near zero, no separation between normal and unusual.

**Interview questions**

> **Q: How does this detect fraud without ever being shown fraud?**
> It learns to rebuild normal transactions only. Anything that doesn't look normal gets
> rebuilt badly, and that rebuild error is the score. Fraud tends to look unusual, but so do
> some legitimate transactions, which is why precision is 13%. The upside is that it can flag
> new fraud patterns nobody has labeled yet.

> **Q: Why must the middle layer be smaller than the input?**
> Otherwise the network can learn to copy inputs straight through, so everything, fraud
> included, gets rebuilt perfectly. The 8-number bottleneck forces it to summarize, and it can
> only summarize well the kind of data it was trained on.

> **Q: Why mean squared error?**
> It's positive, punishes large misses more than small ones, and is the standard reconstruction
> loss. Using the same quantity for training and scoring keeps it simple: the model is trained
> to make exactly this number small on normal data.

---

### 2.3 Training

**Plain English.** The model practices rebuilding normal training transactions over and over.
After each pass, it's checked on normal transactions it didn't practice on. When that check
stops improving, training stops and the best version is kept.

**Key code: train on normal transactions only, hold some back** (`ml/train.py` lines 142–146)

```python
normal = (train_feats[labels["train"] == 0] - mean) / scale
perm = np.random.permutation(len(normal))
n_hold = len(normal) // 10  # 10% of train normals for early stopping (not the validation set)
fit_x = torch.tensor(normal[perm[n_hold:]], dtype=torch.float32)
hold_x = torch.tensor(normal[perm[:n_hold]], dtype=torch.float32)
```

That's **153,470** normal transactions to train on and **17,052** held back. The 360 training
frauds are filtered out; labels are never a training target.

**Key code: the training loop and early stopping** (`ml/train.py` lines 148–172)

```python
opt = torch.optim.Adam(ae.parameters(), lr=1e-3)
loss_fn = nn.MSELoss()
best_loss, best_state, patience, bad_epochs = float("inf"), None, 5, 0
for epoch in range(1, 201):
    ...                                   # one pass in shuffled batches of 512
    if hold_loss < best_loss - 1e-4:      # improved by more than 0.0001
        best_loss, best_state, bad_epochs = hold_loss, {...copy of weights...}, 0
    else:
        bad_epochs += 1
        if bad_epochs >= patience:        # 5 epochs without improvement
            break
ae.load_state_dict(best_state)            # keep the best epoch, not the last
```

**What happened in the run** (from the training log): it trained for **81 epochs**. The last
real improvement was **epoch 76** (held-back error 0.4626 → 0.4622), so it stopped after
epoch 81 and kept epoch 76. The best held-back error is **0.46221**
(`metrics.json` → `training.best_holdout_mse`).

**Determinism** (`ml/train.py` lines 114–116): fixed seeds (`SEED = 42`) and
`torch.set_num_threads(1)`. Two runs produced byte-identical `metrics.json`, and your own rerun
matched the committed files.

**The theory.**
- **Epoch** = one full pass over the training data. **Batch** = 512 transactions at a time; the
  weights update after each batch.
- **Adam** is an optimizer: the rule for nudging weights downhill on the loss. Learning rate
  0.001 is its common default.
- **Overfitting** = memorizing the training transactions instead of learning general patterns.
  For an autoencoder, that would mean rebuilding *new* normal transactions worse, so more false
  alarms. Early stopping watches error on held-back data and stops when it stops improving.
- **Why held-back training normals, not the validation set?** Validation already has one job:
  choosing the threshold. Using it for stopping would also mean using its fraud labels to filter
  it during training. Keeping every training decision inside the training data is cleaner.
- **Honest nuance:** the held-back error flattened rather than rising, so overfitting wasn't
  severe for a 1,319-parameter model on 153,470 rows. Early stopping mostly found the point
  where training stopped helping.

**Alternatives I didn't choose.** A fixed epoch count (you don't know the right number);
regularization like dropout or weight decay (not needed at this size, and not tested);
learning-rate schedules (not tested).

**What would go wrong without it.** Train too little and the model underfits, so normal
transactions still rebuild poorly. Train too long and it can overfit. Without seeds, the numbers
change each run and you can't quote them reliably.

**Interview questions**

> **Q: What does early stopping protect against?**
> Overfitting: memorizing the training transactions instead of learning general normal
> behavior, which would show up as more false alarms on new customers. After each epoch I
> measured error on held-back normals, kept the best version, and stopped after 5 epochs without
> improvement. In this run it stopped at epoch 81 and kept epoch 76.

> **Q: Why not use the validation set for early stopping?**
> Validation has one job, choosing the threshold, and using it during training would mean using
> its fraud labels to filter it. A 10% holdout from the training normals keeps every training
> decision inside the training data.

> **Q: Is the training reproducible?**
> Yes. Fixed seeds and single-threaded math. Two runs gave byte-identical results, so anyone can
> rerun it and get exactly my numbers.

---

### 2.4 Threshold choice

**Plain English.** The model gives every transaction a score. A cutoff, the threshold, decides
which scores become alerts. The cutoff was chosen on the validation period, never by looking at
the test results.

**Key code** (`ml/train.py` lines 203–207)

```python
val_s, val_y, val_amt = scores["validation"], labels["validation"], amounts["validation"]
candidates = np.unique(np.quantile(val_s, np.linspace(0.90, 0.99995, 4000)))
val_results = [evaluate(val_s, val_y, val_amt, t) for t in candidates]
best_val = max(val_results, key=lambda r: (r["f1"], -r["alert_rate"]))
threshold = best_val["threshold"]
```

It tries up to 4,000 candidate cutoffs, taken from the top 10% of validation scores, and keeps
the one with the best **F1**, preferring fewer alerts on ties. Result: **threshold = 6.7455**
(exactly 6.745466810943141).

At that threshold on **validation**: 405 alerts (0.71% of transactions), recall 47.4% (27 of
57), precision 6.7%, F1 0.117.

**The theory.**
- **F1** = 2 × precision × recall ÷ (precision + recall). It's high only when both are
  reasonable, which makes it a common single number for picking a cutoff on rare events.
- **Why validation and not test:** choosing the threshold by looking at test results is like
  grading your own exam after seeing the answer key. The test number would stop predicting
  real performance. The rule: decide on validation, grade once on test, report what comes out.

**Alternatives I didn't choose.**
- **A fixed alert budget**, e.g. "flag the top 1%": very practical, because banks plan around
  analyst capacity. The threshold sweep in `metrics.json` shows exactly that view, with every
  point set from validation.
- **Cost-weighted choice:** pick the cutoff that minimizes expected cost, using the dollar cost
  of a missed fraud vs. a false alarm. That's better in principle, but needs the bank's real
  costs, which I don't have.
- **F-beta** with beta > 1 to favor recall: a reasonable choice if missing fraud costs much
  more than an alert.

**What would go wrong without it.** Picking the threshold on test data, for example choosing
the 1% point because it scored 67%, would make the test result optimistic. Production would
likely come in lower, and the bank would find out after deploying.

**Interview questions**

> **Q: How did you choose the threshold?**
> On validation data only: the cutoff that maximizes F1, which balances catching fraud against
> false alarms. That gave 6.75. The test set played no part, and was scored once afterward.

> **Q: A lower threshold catches 67% of fraud on test. Why not use it?**
> Because I'd be choosing it by looking at the answers. The honest way is to decide the rule
> first, for example from the team's alert capacity, on validation, then grade it once on test.
> The sweep shows the whole trade-off curve for that conversation.

> **Q: Why does the same threshold flag 0.71% on validation but 0.41% on test?**
> Behavior shifts over time. The score distribution in the latest period differs from the
> middle period. It's a small, real example of drift, and in production you'd monitor the alert
> rate for exactly this.

---

### 2.5 Evaluation and metrics

**Plain English.** The model is graded once on the latest 20% of transactions. Each one falls
into one of four boxes, and every metric is built from those four counts.

**Key code** (`ml/train.py` lines 86–110, abbreviated)

```python
flagged = scores >= threshold
fraud = labels == 1
tp = int(np.sum(flagged & fraud))      # fraud we caught
fp = int(np.sum(flagged & ~fraud))     # good customers flagged
fn = int(np.sum(~flagged & fraud))     # fraud we missed
tn = int(np.sum(~flagged & ~fraud))    # good customers left alone
precision = tp / (tp + fp)
recall = tp / (tp + fn)
caught = float(amounts[flagged & fraud].sum())
total = float(amounts[fraud].sum())
```

**Test results** (`metrics.json` → `test`): TP 31 · FP 204 · FN 44 · TN 56,683.
Recall 41.3%, precision 13.2%, alert rate 0.41%, fraud dollars caught $484.50 of $7,729.26
(6.3%). Threshold-free: ROC-AUC 0.968, average precision 0.083.

**The theory.**
- **Recall** looks at the fraud: of all real fraud, how much did we catch?
- **Precision** looks at the alerts: of all alerts, how many were real fraud?
- **Accuracy is useless here.** Flagging nothing at all would be 99.87% accurate, because
  1 − 0.13% fraud = 99.87%.
- **ROC-AUC (0.968)** answers: pick one random fraud and one random legitimate transaction;
  how often does the fraud score higher? It counts false alarms against all 56,887 legitimate
  transactions, so even many mistakes look small. 0.968 still means a typical fraud is
  outranked by about 3.2% of legitimate transactions, roughly 1,800 of them.
- **Average precision (0.083)** summarizes precision across all recall levels. It counts false
  alarms against the *alerts*, which is what analysts experience. Random ranking would score the
  base rate, 0.0013, so 0.083 is about **63×** better than random. It's low partly because the
  very highest scores were all false alarms: the top 76 test alerts contained no fraud.
- **Which one should a bank trust?** Average precision, or precision at its own alert volume.
  On rare events ROC-AUC almost always looks good.

**Different people read the same four numbers differently:**
- **Risk team → recall and fraud dollars:** 44 frauds missed, $7,244.76 of fraud dollars missed.
- **Operations → precision:** 235 alerts for 31 real frauds, about 7.6 alerts reviewed per
  fraud found.
- **Customer experience → false positives:** 204 of 56,887 legitimate customers flagged,
  0.36%, about 1 in 280.

**What would go wrong without it.** Reporting accuracy or ROC-AUC alone would make the model
look far better than it is for the bank.

**Interview questions**

> **Q: Why is ROC-AUC 0.97 but average precision only 0.08?**
> They measure mistakes against different things. ROC-AUC compares false alarms to all 56,887
> legitimate transactions, so they look tiny. Average precision compares them to the alerts,
> which is what analysts see, and fraud's rarity drags it down. Still, 0.08 is about 63 times
> better than random. A bank should trust average precision or precision at its alert volume.

> **Q: Walk me through TP, FP, FN, TN and your precision and recall.**
> 31 frauds caught, 204 good customers flagged, 44 frauds missed, 56,683 good customers left
> alone. Recall = 31 ÷ 75 = 41%. Precision = 31 ÷ 235 = 13%. About 1 in 8 alerts is real,
> against a base rate of 1 in 760.

> **Q: Why is fraud-dollar capture only 6%?**
> "Unusual" isn't "fraud." It catches many small card-testing charges (45 of the 75 test frauds
> are $10 or less) but missed the five largest frauds, which hold 60% of the fraud dollars. The
> biggest frauds blend in with big legitimate purchases, which also score high.

---

### 2.6 ONNX export

**Plain English.** ONNX is a standard file format for trained models, like PDF for machine
learning. The model is trained in Python but runs in Java by loading one file. The feature steps
are built into that file, so Java sends raw fields and gets a score back.

**Key code: the exported module does everything** (`ml/train.py` lines 75–83)

```python
def forward(self, transactions):
    t = transactions[:, 0:1]
    v = transactions[:, 1:29]
    amount = transactions[:, 29:30]
    seconds_of_day = t - torch.floor(t / SECONDS_PER_DAY) * SECONDS_PER_DAY
    phase = 2 * math.pi * seconds_of_day / SECONDS_PER_DAY
    feats = torch.cat([v, torch.log(amount + 1.0), torch.sin(phase), torch.cos(phase)], dim=1)
    z = (feats - self.mean) / self.scale
    return torch.mean((self.ae(z) - z) ** 2, dim=1)
```

The training means and standard deviations are stored inside the module (lines 72–73,
`register_buffer`), so they're exported with it.

**Key code: export and check** (`ml/train.py` lines 180–200)

```python
torch.onnx.export(scorer, (example,), str(ONNX_PATH),
    input_names=["transactions"], output_names=["score"],
    dynamic_shapes={"transactions": {0: torch.export.Dim("batch")}}, dynamo=True, external_data=False)
...
assert np.allclose(scores["test"], torch_test, rtol=1e-5, atol=1e-5), "ONNX export does not match PyTorch"
```

Input: `float32[N, 30]` in the order Time, V1..V28, Amount. Output: `float32[N]` scores. The file
is about 30 KB. ONNX matches PyTorch on the whole test set: max relative difference 9.5 × 10⁻⁷.
All of the replay scores were produced by ONNX Runtime, not PyTorch.

**The theory.**
- **Why not call Python from Java?** That's an extra service to run and monitor, an extra network
  hop per transaction, and Python is often unwelcome in a bank's Java production stack.
- **Why not rewrite the model in Java?** Every retrain would need re-coding, and any small
  difference gives silently wrong scores.
- **Training/serving skew** is when production prepares inputs differently from training: say
  `log10` instead of natural log, a forgotten "+1", old averages, or a different column order.
  Nothing errors; the scores are just wrong. Baking the steps into the file removes the risk.
- **Floats:** the model uses 32-bit numbers. Results differ in the last digit or two between
  implementations, so they're compared within a tolerance, never for exact equality.

**Alternatives I didn't choose.** PMML (an older model-exchange standard, weaker for neural
networks); TorchScript (PyTorch-specific); a Python model server (an extra runtime in production).

**What would go wrong without it.** Either a Python dependency in production, or a hand-written
Java copy that drifts from the trained model.

**Interview questions**

> **Q: What is ONNX and why use it?**
> An open, standard format for trained models. I train in PyTorch, export one small file, and the
> Java service runs it with ONNX Runtime. Data scientists keep their tools, the platform team
> keeps theirs, and the hand-off is one versioned file.

> **Q: What does "scaling baked in" mean?**
> The log of the amount, the sine and cosine of time, and the standardization with training-set
> averages are all part of the exported model. Java sends the raw 30 fields; there's no feature
> code to re-implement, so nothing can drift.

> **Q: How do you know the export is correct?**
> The training script asserts that ONNX matches PyTorch on every test transaction: max relative
> difference 9.5 × 10⁻⁷. The Java test then checks Java against those scores.

---

### 2.7 The Java API

**Plain English.** A small web service. Send it one transaction as JSON and it returns the score
and whether to alert. It also reports its health and serves the held-out results.

**Key code: loading the model once** (`api/src/main/java/com/frauddemo/api/ScoringService.java`
lines 52–59)

```java
byte[] modelBytes = Files.readAllBytes(this.modelPath);
this.modelVersion = sha256(modelBytes).substring(0, 12);
this.metricsJson = Files.readString(metrics);
// The alert threshold was chosen on the validation set in Phase 1; we serve exactly that value.
this.threshold = JsonMapper.builder().build().readTree(metricsJson).get("threshold").asDouble();

this.env = OrtEnvironment.getEnvironment();
this.session = env.createSession(modelBytes, new OrtSession.SessionOptions());
```

**Key code: scoring** (`ScoringService.java` lines 70–75)

```java
public float[] score(float[][] rows) throws OrtException {
    try (OnnxTensor input = OnnxTensor.createTensor(env, rows);
         OrtSession.Result result = session.run(Map.of("transactions", input))) {
        return (float[]) result.get(0).getValue();
    }
}
```

**Key code: the endpoint** (`api/src/main/java/com/frauddemo/api/ScoreController.java`
lines 35–56). It checks the input, scores, applies `flagged = score >= threshold` (line 40),
writes one structured log line, and returns
`{id, score, threshold, flagged, modelVersion, latencyMs}`.

**Input validation** (`ScoreController.java` lines 74–97): every one of the 30 fields must be
present and numeric. It lists *all* missing fields in one error, rejects NaN and infinity, and
rejects negative `Time` or `Amount`. Bad input gets HTTP **400** via `ApiExceptionHandler.java`
(lines 18–25).

**Endpoints:** `POST /score`, `GET /health`, `GET /metrics` (`metrics.json`, unchanged).

**Structured logging** (`api/src/main/resources/application.properties` line 9:
`logging.structured.format.console=ecs`): every log line is a JSON object in Elastic Common
Schema, with fields like `score`, `flagged` and `model_version`.

**The parity test** (`api/src/test/java/com/frauddemo/api/ScoringParityTest.java` lines 16–51)
scores all 2,075 replay rows in Java and compares each to Python's score:
`relDiff = |java − python| ÷ max(1, |python|)` must be ≤ 1e-5, and alert decisions must match.
Measured: **max 2.13 × 10⁻⁷, 0 mismatches**.

**Measured speed** (500 sequential requests on this laptop, Phase 2): scoring median
**0.035 ms** (99th percentile 0.080 ms); full HTTP round trip median **0.44 ms** (99th
percentile 1.0 ms). These were measured with no network in between; a bank deployment adds
network time.

**The theory.**
- **Spring Boot** is the most common Java framework for web services. **Dependency injection**
  means Spring creates one `ScoringService` at startup and hands it to the controller, so the
  model loads once.
- **Thread safety:** requests run on many threads sharing one service. The service never changes
  after startup, and ONNX Runtime documents that a session's `run` can be called concurrently.
- **`try (...)`** releases native memory that ONNX Runtime allocates outside Java's garbage
  collector.
- **400 vs. 500:** 4xx means the caller's request was wrong; 5xx means the server broke. Filling
  missing fields with zeros would give confident-looking wrong scores, which is worse than an error.
- **The model version** is the first 12 characters of the model file's SHA-256 fingerprint,
  `8acf9b76003f`. Every response and log line carries it: an audit trail.

**Alternatives I didn't choose.** A typed request class with an OpenAPI spec (stricter and
self-documenting; I used a `Map` so field names match the CSV exactly); batch scoring (faster,
but real card authorizations are one at a time); Spring Boot Actuator for health (more
features, more dependencies).

**What would go wrong without it.** No contract test means a broken retrain could ship silently.
Without validation, garbage in gives confident garbage out. Plain-text logs can't be queried.

**Interview questions**

> **Q: How do you know the Java scores are right?**
> An automated test scores all 2,075 replay transactions in Java and compares them with Python's
> scores: the max difference is 2.1 × 10⁻⁷ and every alert decision matches. It runs on every
> build, so a mismatched retrain fails before it ships.

> **Q: Is it thread-safe?**
> Yes. Everything is set once at startup and never changes, and ONNX Runtime sessions support
> concurrent `run` calls. Each request gets its own input tensor, released after use.

> **Q: Is this production-ready?**
> No: it's demo-grade on production patterns. Production needs authentication, rate limiting,
> drift monitoring, a fallback if scoring fails, several instances behind a load balancer, and a
> controlled rollout for new models, for example shadow mode first.

---

### 2.8 The replay server

**Plain English.** Stands in for the bank's live transaction feed. It reads the demo file, sends
one transaction every third of a second to the Java API, and pushes each result to every open
dashboard.

**Key code: the demo fraud rule** (`replay/src/replay-data.js` lines 46–49)

```javascript
export function pickDemoFraud(rows, threshold, minMargin = 1.25) {
  const candidates = rows.filter((r) => r.label === 1 && r.pythonScore >= threshold * minMargin);
  ...
  return candidates.reduce((best, r) => (r.amount > best.amount ? r : best));
}
```

The rule is the largest-dollar fraud that Phase 1 scored at least 1.25× the threshold. It
selects **replay row 1293, $127.14, score 10.03 (1.49×)**. `buildSequence` (lines 56–61) moves
only that row, to position `round(20 × rate)`, which is position 60 at 3 per second.

**Key code: the play loop and outage handling** (`replay/src/server.js` lines 199–232)

```javascript
try {
  result = await scoreRow(row);
} catch (e) {
  if (run === runId && state !== 'paused') {
    // Keep the same transaction and retry; the stream resumes where it stopped.
    setState('api_unavailable', { error: e.message });
    nextDueAt = Date.now() + RETRY_MS;
  }
  continue;
}
if (run !== runId || stopped) continue; // restarted while this request was in flight
```

**Steady pacing** (lines 261–262): the next send is scheduled from the previous *scheduled*
time, and after a pause or outage it never bursts to catch up.

**Settings:** rate limited to 2–5 per second (line 18), 2-second request timeout (line 37),
1-second retry (line 21), last 100 events and last 5 alerts kept for snapshots (lines 19–20).

**Messages to dashboards:** `hello` and `reset` (full snapshots with totals, the last 100
events and the last 5 alerts), `scored` (one result), `status`, `config`.

**Measured** (Phase 3 live run, real Java API): the scripted fraud played at **20.01 s**. After
I killed the API at 26 s, the status went to `api_unavailable` and back to `running` at
32.1 s, after the API restarted. Transactions #78 → #79 were consecutive, so nothing was skipped.
The median gap between transactions was 0.333 s against a 0.333 s target.

**The theory.**
- **WebSocket** keeps a connection open so the server can *push* results. Plain HTTP would make
  the browser keep asking (polling).
- **Snapshots on connect** let a refreshed or late-joining dashboard rebuild instantly.
- **Run IDs** discard results from before a Restart, so totals can't mix runs.
- **Why one transaction at a time:** it mirrors card authorization, where each swipe needs its
  own answer.

**Alternatives I didn't choose.** A message queue (Kafka, IBM MQ) as the feed, which is what
production would use; Server-Sent Events instead of WebSocket (one-way, and simpler); batch
scoring.

**What would go wrong without it.** An API restart would freeze or crash the demo; a page refresh
would show a blank dashboard; you'd wait an unknown time for the first alert.

**Interview questions**

> **Q: What happens if the scoring API goes down mid-demo?**
> The replay server marks the stream `api_unavailable`, retries the same transaction every
> second, and resumes exactly where it stopped. I tested it by killing the API: nothing was
> skipped or double-counted.

> **Q: Isn't moving a fraud case to 20 seconds cheating?**
> It would be if I hid it. It's a real held-out fraud chosen by a fixed rule, scored live by the
> real model, and the dashboard discloses that it was moved. Everything else plays in its real
> order, misses and false alarms included.

> **Q: Why are the stream counters not shown as rates?**
> The replay is enriched: all 75 test frauds plus 2,000 normals, about 3.6% fraud against 0.13%
> in reality. Rates from it would overstate performance. The panel to judge the model by uses
> held-out test results only.

---

### 2.9 The dashboard

**Plain English.** The screen you present. The left side is the live demo stream; the right side
is the held-out results. They're kept visually and logically separate.

**Key code: the headline is computed, never typed** (`dashboard/src/metrics.ts` lines 15–34)

```typescript
const alertQuality =
  t.precision && t.precision > 0
    ? `About 1 in ${oneIn(1 / t.precision)} alerts is real fraud, vs. a 1 in ${count(oneIn(1 / baseRate))} base rate, ` +
      `so an alert is ~${roundSig(t.precision / baseRate, 2)}× more likely to be fraud than a random transaction.`
    : 'No alerts were raised on the test data at this threshold.';
...
headline: `Caught ${pct(t.recall ?? 0)} of fraud cases while flagging ${pct(t.alert_rate)} of transactions`,
```

Rounding rules (`dashboard/src/format.ts`): `pct` (line 4) shows whole percents at 10% and above
and one decimal below that; `oneIn` (line 20) rounds small numbers to whole numbers (7.58 → 8)
and large ones to two significant figures (759.49 → 760); `roundSig` (line 13) gives 100.19 → 100.

**Key code: dashboard state** (`dashboard/src/stream.ts`): keeps the last 120 events (line 4)
and the last 5 alerts (line 6). Snapshots replace everything (lines 59–60), and the reset
counter only counts `reset` messages.

**Connection** (`dashboard/src/connections.ts` lines 7–8, 29): talks only to the replay server
on port 8081 and reconnects every second if the connection drops.

**Live score chart** (`dashboard/src/components/ScoreChart.tsx` lines 10–17): the last 90
transactions, on a log scale from 0.1 to 100. Replay scores range from 0.113 to 26.6. Shapes and
colors: circle = legitimate, diamond = actually fraud, red = alerted, blue = passed. **A blue
diamond below the line is a missed fraud.**

**The theory.**
- **Log scales**: scores span orders of magnitude, and the interesting thresholds sit between
  0.02% and 1% flagged. On a linear axis they'd be squashed against one edge.
- **Hand-drawn SVG charts** instead of a chart library: fewer dependencies to break live.
- **Colors** were run through a colorblind-safety and contrast checker (both modes passed), and
  every color has a second cue (shape, label or icon).

**Alternatives I didn't choose.** A charting library such as Recharts (faster to build, more to
break); polling instead of WebSocket; showing stream rates (misleading, as above).

**What would go wrong without it.** Typed-in numbers drift from the metrics file after a retrain.
Mixing stream counts with held-out metrics would overstate performance.

**Interview questions**

> **Q: Where do the numbers on the right come from?**
> From `metrics.json`, served by the Java API and passed through the replay server. The sentences
> are built from those values at run time, so retraining updates the panel automatically. Tests
> check the exact sentences against the real file.

> **Q: What do the blue diamonds mean?**
> Real fraud cases that scored below the threshold, so the model let them through. I show the
> misses on purpose.

> **Q: What happens if someone refreshes the page mid-demo?**
> The replay server sends a snapshot on every new connection: totals, the last 100 events and the
> last 5 alerts. The page rebuilds instantly. I tested refreshing with alerts older than the last
> 100 transactions, and the panel still showed all five.

---

### 2.10 start.sh and reliability

**Plain English.** One command starts everything in the right order, waits until each piece is
actually working, and keeps it running. One command stops it all.

**Key code** (`start.sh`):
- **Lines 70–90:** a tool only counts if it actually runs. macOS ships a placeholder
  `/usr/bin/java` that just prints an error, so `tool_works` runs `java -version`. If Java or
  Node isn't on the PATH, it looks in `~/tools`.
- **Line 92:** `port_owner` refuses to start if a port is already in use, and names the program.
- **Lines 147 onward:** each service is started with `exec`, so the recorded process ID is the
  real service.
- **Line 161:** `wait_healthy` polls each health URL until it answers correctly, or shows the
  log and stops.
- **Line 192:** `caffeinate` keeps the Mac awake while the script runs.
- **Line 208 onward:** the supervisor loop restarts a crashed service, up to 3 times (line 23).
- **Lines 62–64:** traps stop everything on Ctrl+C and report unexpected errors with a line
  number.
- **Line 122:** writes `logs/start.pid`, so `stop.sh` (line 28) stops the supervisor first;
  otherwise the supervisor would restart what `stop.sh` killed.

**Tested in Phase 5:**
- a clean start from deleted build outputs, without the shell profile
- killing the Java API, which came back in about 2 s
- killing the replay server, which came back in about 1 s
- Ctrl+C, after which all ports were freed
- a port conflict, which was refused with the program's name
- `stop.sh` leaving an unrelated program alone

**Bugs the end-to-end run found and fixed:** the placeholder `java` fooled the check *and* the
script exited silently; the free-port check crashed when ports were free (`lsof` exits with an
error when nothing listens); and `stop.sh` couldn't stop a running supervisor.

**Interview questions**

> **Q: How do you make a live demo reliable?**
> Run it end to end from scratch, and test the failure paths, not just the happy path. I killed
> each service mid-stream to prove recovery, and the clean-start run found three real bugs in my
> startup script.

> **Q: Why does start.sh wait for health checks instead of sleeping a few seconds?**
> Startup time varies, especially on a first build. A health check proves the service is actually
> ready; a sleep just hopes.

> **Q: What does the supervisor do?**
> Every 2 seconds it checks each service's process. If one has died, it restarts it and waits for
> its health check, up to 3 times per service.

---

### 2.11 The sensitivity slider

**Plain English.** A what-if control. Drag it to see what would happen at a different threshold,
on the same held-out test data. It's display-only: live alerts keep using the threshold chosen
on validation.

**Key code: snap points** (`dashboard/src/metrics.ts`, `sensitivitySteps`): the 15 sweep points
plus the chosen threshold make **16 positions**, ordered from fewest to most alerts. The default
is position 7 (counting from 0), the threshold 6.75.

**Key code: display-only state** (`dashboard/src/App.tsx` lines 16–21)

```typescript
// Sensitivity slider: display-only, never sent to the server. null = the validation-chosen default.
const steps = useMemo(() => (metrics ? sensitivitySteps(metrics) : null), [metrics]);
const [whatIfIndex, setWhatIfIndex] = useState<number | null>(null);
useEffect(() => setWhatIfIndex(null), [stream.resets]); // Restart (or a replay loop) resets it
```

**Readout:** fraud cases caught, fraud dollars caught, and alerts per 100,000 transactions
(alert rate × 100,000).

**Tested in Phase 6:** all 16 positions matched `metrics.json`. Moving through them sent zero
network requests, the headline stayed at "41% … 0.4%", the setting survived live transactions,
and Restart reset it.

**The theory.** The threshold is a business decision. Showing its consequences is useful, but
changing the live threshold should be a reviewed release, not a slider in a demo. That's why the
live threshold line stays on the chart next to the what-if line: the red dots are real decisions
at 6.75.

**Interview questions**

> **Q: What would you pick if your team could review 1% of transactions?**
> On held-out data, 1.02% flagged catches 67% of fraud cases and 57% of fraud dollars, about
> 1,020 alerts per 100,000. I'd validate that choice on fresh data before switching.

> **Q: Why doesn't the slider change the live alerts?**
> Reliability and governance. The demo can't break, and in a bank a threshold change goes through
> review because it changes customer experience and analyst workload.

> **Q: Are the slider's numbers honest?**
> Yes. Every point's threshold was set from validation data, then measured once on test data. I
> didn't pick any point by looking at test results.

---

## 3. Every number, explained

Source key: **M** = `artifacts/metrics.json`, **R** = computed from `data/replay.csv` or the
dataset, **T** = measured in a test or run while building the project.

### Data

| Number | Meaning | Source / calculation |
|---|---|---|
| 284,807 | Transactions in the dataset | R: row count |
| 492 (0.17%) | Fraud cases in the dataset | R: sum of `Class` |
| 172,792 s (~48 h) | Time span | R: max `Time` |
| 1,081 | Exact duplicate rows | R: `df.duplicated().sum()` |
| 170,882 / 56,963 / 56,962 | Train / validation / test rows | M: `split` |
| 360 / 57 / 75 | Fraud in train / validation / test | M: `split` |
| $21.89 / $87.34 / $19,656.53 | Training amount median / mean / max | R |
| 80.1% | Training transactions under $100 | R |

### Model and training

| Number | Meaning | Source / calculation |
|---|---|---|
| 31 | Features per transaction | 28 V-columns + log amount + sin + cos |
| 1,319 | Learned parameters | R: counted from `fraud_scorer.pt` |
| 153,470 / 17,052 | Normal transactions trained on / held back | M: `training` (10% of 170,522 normals) |
| 81 / 76 | Epochs run / epoch kept | T: training log |
| 0.46221 | Best held-back reconstruction error | M: `training.best_holdout_mse` |
| 6.7455 | Alert threshold | M: `threshold` (max F1 on validation) |
| 9.5 × 10⁻⁷ | Max relative ONNX vs. PyTorch difference | M: `onnx.max_relative_diff_vs_pytorch` |
| `8acf9b76003f` | Model version | T: SHA-256 of the ONNX file, first 12 characters |

### Validation (at the threshold)

| Number | Meaning | Source |
|---|---|---|
| 405 (0.71%) | Alerts | M: `validation_at_threshold` |
| 27 / 378 / 30 | TP / FP / FN | M |
| 47.4% / 6.7% / 0.117 | Recall / precision / F1 | M |

### Test (held out, scored once)

| Number | Meaning | Calculation |
|---|---|---|
| TP 31 · FP 204 · FN 44 · TN 56,683 | The four outcomes | M: `test` |
| 41.3% | Recall | 31 ÷ (31 + 44) |
| 13.2% | Precision | 31 ÷ (31 + 204) |
| 0.41% | Alert rate | 235 ÷ 56,962 |
| 0.2 | F1 | 2 × 31 ÷ (235 + 75) = 62 ÷ 310 |
| $484.50 of $7,729.26 (6.3%) | Fraud dollars caught | Sum of `Amount` over TP ÷ over all fraud |
| 0.13% (1 in 760) | Fraud base rate | 75 ÷ 56,962; 1 ÷ 0.0013167 = 759.5 |
| ~100× | Precision ÷ base rate | 0.1319 ÷ 0.0013167 = 100.2 |
| 0.36% (1 in 280) | Legitimate customers flagged | 204 ÷ 56,887 |
| 0.968 | ROC-AUC | M: `test_threshold_free.roc_auc` |
| 0.083 (~63× random) | Average precision | M; 0.0831 ÷ 0.0013 |
| 99.87% | Accuracy of never flagging | 1 − 0.13% |
| 45 of 75 | Test frauds of $10 or less | R; the median test fraud is $4.69 |
| 60% | Share of fraud dollars in the 5 largest frauds | R: ($1,504.93 + $1,096.99 + $996.27 + $634.30 + $390.00) ÷ $7,729.26 |
| $127.14 | Largest fraud the model caught | R |

### Threshold sweep (test, thresholds set on validation)

| Flagged | Fraud cases caught | Precision | Fraud dollars caught | Alerts per 100,000 |
|---|---|---|---|---|
| 0.13% | 0.0% | 0.0% | 0.0% | 133 |
| 0.28% | 28.0% | 13.0% | 2.7% | 284 |
| **0.41% (default)** | **41.3%** | **13.2%** | **6.3%** | **413** |
| 0.65% | 50.7% | 10.3% | 19.4% | 650 |
| 1.02% | 66.7% | 8.6% | 56.5% | 1,020 |
| 1.44% | 77.3% | 7.0% | 68.4% | 1,445 |
| 9.21% | 88.0% | 1.3% | 69.6% | 9,211 |

### Serving and demo (measured)

| Number | Meaning | Source |
|---|---|---|
| 2.13 × 10⁻⁷, 0 mismatches | Max Java vs. Python difference across 2,075 rows | T: `ScoringParityTest` |
| 0.035 ms (p99 0.080) | Scoring time | T: 500 requests, Phase 2 |
| 0.44 ms (p99 1.0) | Full HTTP round trip | T: same run |
| 2,075 (75 fraud, ~3.6%) | Demo stream size | R |
| 20.01 s / 20.0 s | When the scripted fraud played | T: Phase 3 run / Phase 5 run |
| ~2 s / ~1 s | Recovery after killing the API / the replay server | T: Phase 5 |
| ~11.5 min | Stream length at 3 per second | 2,075 ÷ 3 = 692 s |
| 9 / 15 / 16 | Tests: Java / replay / dashboard | T |

### Worked example: from four counts to the panel's second line

The panel says: *"About 1 in 8 alerts is real fraud, vs. a 1 in 760 base rate, so an alert is
~100× more likely to be fraud than a random transaction."*

1. **Precision.** 31 of 235 alerts were fraud: 31 ÷ 235 = 0.1319.
2. **1 in N alerts.** 1 ÷ 0.1319 = 7.58. Under 20, so round to a whole number: **8**.
3. **Base rate.** 75 frauds in 56,962 transactions: 75 ÷ 56,962 = 0.001317.
4. **1 in N transactions.** 1 ÷ 0.001317 = 759.5. Over 20, so round to two significant figures: **760**.
5. **Lift.** 0.1319 ÷ 0.001317 = 100.2. Two significant figures: **~100×**.

The dashboard does exactly this at run time from `metrics.json` (`dashboard/src/metrics.ts`
lines 20–24), and a test checks the final sentence word for word.

---

## 4. Known limitations and how to talk about them

**How to bring them up:** state the limit, give the number, then say what you'd do about it.
Saying it before you're asked builds trust.

1. **It catches 6% of fraud dollars.** It flags *unusual*, not *fraud*. It caught many small
   card-testing charges but missed the five largest frauds, which hold 60% of fraud dollars, and
   large legitimate purchases score high too: the top 100 validation scores held 1 fraud, with a
   median amount of $518.71.
   *What I'd do:* add a supervised model for known patterns, rank alerts by expected dollar
   loss, and add rules for high-value transactions.
2. **Precision is 13%.** Analysts review about 7.6 alerts per real fraud.
   *What I'd do:* add context features and a supervised model, and tune with the ops team's capacity.
3. **The test set is small.** 75 frauds; each one moves recall by 1.3 points, so "41%" means
   "roughly 40%".
   *What I'd do:* a pilot on months of the bank's own data, with walk-forward testing.
4. **Two days of anonymized data.** There's no merchant, device or location data, and V1–V28
   can't be explained in business terms.
   *What I'd do:* use real features; add explanations, such as which features contributed most
   to the rebuild error.
5. **Drift is already visible.** The same threshold flagged 0.71% of validation but 0.41% of test.
   *What I'd do:* monitor alert rate and score distribution, and retrain on a schedule.
6. **"Time of day" assumes the data starts at midnight.** `Time` is relative. Counting
   transactions by hour of the 24-hour cycle (both days combined), hours 2–6 are the quietest,
   with as few as about 2,000 an hour against about 16,000–17,000 at peak (lowest ÷ highest =
   0.125). That's what nighttime would look like, so it supports the assumption, but it doesn't
   prove it.
7. **The architecture isn't tuned.** 31 → 16 → 8 → 16 → 31 is a reasonable small default.
   I didn't compare other sizes or other anomaly detectors, so I can't claim it's the best choice.
8. **The demo shows ground truth instantly.** Banks learn it weeks later from chargebacks.
9. **The API is demo-grade.** There's no authentication, rate limiting, fallback or drift
   monitoring (see section 2.7).
10. **Privacy note:** the ONNX file includes a local file path from my Mac as debugging
    metadata. It's harmless, and I chose to leave it.

---

## 5. Glossary

| Term | Meaning |
|---|---|
| **Adam** | A popular optimizer: the rule for adjusting weights to reduce the loss. |
| **Alert rate** | Share of transactions flagged. Here 0.41% on test. |
| **Anomaly detection** | Finding data that doesn't look like normal data, without needing labels for the anomalies. |
| **Autoencoder** | A neural network trained to rebuild its input through a smaller middle layer. |
| **Average precision (AP)** | Summary of precision across all recall levels; suited to rare events. Random = base rate. |
| **Base rate** | How common the positive class is. Here 0.13% fraud on test. |
| **Batch** | A group of examples processed together before one weight update (512 here). |
| **Bottleneck** | The narrow middle layer (8 numbers) that forces the autoencoder to summarize. |
| **Chargeback** | A customer disputing a charge; often how a bank confirms fraud, weeks later. |
| **Chronological split** | Splitting data by time: past for training, latest for testing. |
| **Confusion matrix** | The four counts TP, FP, FN, TN. |
| **Contract test** | A test that checks two systems agree (here, Java and Python scores). |
| **Data leakage** | Information from the test or future period sneaking into training, so results look better than reality. |
| **Dependency injection** | A framework (Spring) creating objects and handing them to the code that needs them. |
| **Drift** | Data or behavior changing over time, so a model's performance changes. |
| **Early stopping** | Stopping training when error on held-back data stops improving. |
| **ECS** | Elastic Common Schema: standard field names for JSON logs. |
| **Epoch** | One full pass over the training data. |
| **F1 score** | 2 × precision × recall ÷ (precision + recall). |
| **False negative (FN)** | Fraud the model missed. |
| **False positive (FP)** | A legitimate transaction flagged as fraud. |
| **Feature** | A number describing a transaction that the model uses as input. |
| **Health check** | An endpoint that reports whether a service is ready. |
| **Held-out data** | Data never used for training or decisions, kept for the final grade. |
| **Log scale** | An axis where each step multiplies by a constant (0.1, 1, 10, 100). |
| **Mean squared error (MSE)** | The average of squared differences; here, the reconstruction error and the score. |
| **Model version** | First 12 characters of the model file's SHA-256 fingerprint. |
| **ONNX** | Open Neural Network Exchange: a standard file format for trained models. |
| **ONNX Runtime** | The engine that runs ONNX models (in Python and Java here). |
| **Overfitting** | Memorizing training data instead of learning general patterns. |
| **Parity** | Two implementations giving the same results within a tolerance. |
| **PCA** | Principal component analysis; how the dataset's publishers anonymized V1–V28. |
| **Precision** | Of all alerts, the share that were real fraud. |
| **Recall** | Of all real fraud, the share caught. |
| **ReLU** | Activation function max(0, x); lets networks learn non-linear patterns. |
| **Replay** | Playing recorded transactions as if they were live. |
| **ROC-AUC** | The probability that a random fraud scores higher than a random legitimate transaction. |
| **Seed** | A fixed starting value for random choices, so results are reproducible. |
| **Snapshot** | The full current state sent to a newly connected dashboard. |
| **Spring Boot** | A widely used Java framework for web services. |
| **Standardization** | Subtracting the mean and dividing by the standard deviation. |
| **Supervised model** | A model trained on labeled examples of each class. |
| **Supervisor** | A process that watches other processes and restarts them if they crash. |
| **Tensor** | A grid of numbers; the model's input and output format. |
| **Threshold** | The score cutoff above which a transaction is flagged. |
| **Threshold sweep** | Results measured at many thresholds, to show the trade-off. |
| **Training/serving skew** | Production preparing inputs differently from training, which gives silently wrong scores. |
| **True negative (TN)** | A legitimate transaction correctly left alone. |
| **True positive (TP)** | Fraud correctly flagged. |
| **Validation set** | Data used for decisions (here, the threshold), separate from training and test. |
| **Walk-forward validation** | Repeated train-then-test rounds moving forward in time. |
| **WebSocket** | A connection that stays open so the server can push messages. |

---

## 6. Self-quiz

Answer each question out loud before reading the answer.

**1. (Easy) What is the fraud score?**
The autoencoder's reconstruction error: the mean squared difference between a transaction's 31
scaled features and their rebuild.

**2. (Easy) How many test transactions, and how many were fraud?**
56,962 transactions, 75 fraud.

**3. (Easy) What are the recall and precision on test?**
Recall 41.3% (31 of 75). Precision 13.2% (31 of 235).

**4. (Easy) What's the alert threshold, and where did it come from?**
6.7455, the score that maximized F1 on the validation set.

**5. (Easy) What are the three splits and their sizes?**
Chronological: first 60% train (170,882), next 20% validation (56,963), last 20% test (56,962).

**6. (Medium) Why is accuracy a bad metric here?**
Never flagging anything is 99.87% accurate, because only 0.13% of transactions are fraud.

**7. (Medium) Why log(1 + Amount)?**
Amounts are heavily skewed (median $21.89, max $19,656.53). The log makes each 10× jump an equal
step so huge purchases don't dominate the error; the "1 +" handles $0.

**8. (Medium) What's the difference between leakage and overfitting?**
Leakage: test or future information sneaks into training. Overfitting: the model memorizes its
training data instead of learning general patterns.

**9. (Medium) Why does the bottleneck need to be smaller than the input?**
Otherwise the network can copy inputs through and rebuild everything perfectly, fraud included.

**10. (Medium) Why was early stopping done on training normals, not validation?**
Validation's only job is choosing the threshold; using it in training would also mean using its
fraud labels. Keeping training decisions inside training data is cleaner.

**11. (Medium) At which epoch did training stop, and which epoch was kept?**
Stopped after epoch 81; kept epoch 76, the last improvement of more than 0.0001.

**12. (Medium) What does "1 in 8 vs. 1 in 760" mean?**
About 1 in 8 alerts is real fraud (precision 13.2%), while 1 in 760 transactions is fraud overall
(base rate 0.13%). An alert is about 100× more likely to be fraud than a random transaction.

**13. (Medium) Why is ROC-AUC high but average precision low?**
ROC-AUC counts false alarms against all 56,887 legitimate transactions, so they look small;
average precision counts them against the alerts. AP of 0.083 is still about 63× random.

**14. (Medium) What is ONNX, and why use it?**
A standard model file format. Train in Python, serve in Java with ONNX Runtime, with no Python in
production and no hand-rewritten model.

**15. (Medium) What does the Java parity test prove?**
Java's scores match Python's on all 2,075 replay transactions (max relative difference
2.13 × 10⁻⁷), with identical alert decisions.

**16. (Medium) Why are the stream counters not shown as rates?**
The replay is enriched (about 3.6% fraud vs. 0.13% real), so rates would overstate performance.

**17. (Hard) Why not switch to the threshold that catches 67% on test?**
Choosing it from test results would make the test number optimistic. Decide the rule on
validation (for example from alert capacity), then grade once on test.

**18. (Hard) Why does the same threshold flag 0.71% on validation but 0.41% on test?**
Drift: the score distribution differs between periods. It's why production needs alert-rate monitoring.

**19. (Hard) Why is fraud-dollar capture only 6.3%?**
The model catches small card-testing frauds (45 of 75 are $10 or less) but missed the five largest,
which hold 60% of fraud dollars. Large legitimate purchases also score high, so big frauds blend in.

**20. (Hard) What is training/serving skew, and how does this project prevent it?**
Production preparing inputs differently from training. The log, sine/cosine and scaling are
inside the ONNX file, so Java has nothing to re-implement, and the parity test checks the result.

**21. (Hard) What happens if the Java API crashes mid-demo?**
The replay server reports `api_unavailable` and retries the same transaction every second;
`start.sh` restarts the API. The stream resumes without skipping. Measured recovery: about 2 seconds.

**22. (Hard) Is the demo's 20-second fraud honest?**
Yes, if disclosed: it's a real held-out fraud chosen by a fixed rule (largest-dollar fraud scored
≥ 1.25× the threshold), scored live, and only its timing is changed.

**23. (Hard) Why does the slider not change live alerts?**
It's a what-if on held-out data. Keeping it display-only means it can't break the demo, and a
real threshold change should go through review.

**24. (Hard) Name three things needed for production.**
Any three of: authentication, rate limiting, drift monitoring, a fallback if scoring fails,
several instances behind a load balancer, a model registry and shadow-mode rollout, a supervised
model alongside, and the bank's own features.

**25. (Hard) If you had one more week, what would you do first, and why?**
A strong answer: add a supervised model on the labeled fraud and combine it with the autoencoder,
because the biggest gap is high-value fraud, and known patterns are exactly what supervised models
catch. Then evaluate with walk-forward testing to see whether the gain holds over time. (Other
reasonable answers exist; what matters is tying the next step to the biggest measured weakness.)
