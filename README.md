# Card fraud detection: live scoring demo

An end-to-end fraud scoring demo built for a 5–10 minute live presentation. An
autoencoder learns what normal card transactions look like, a Java service scores
transactions in real time, and a dashboard shows the scores as they stream in,
next to honest results measured on held-out data.

```
data/creditcard.csv
   │  ml/train.py  (PyTorch, Python)
   ▼
artifacts/fraud_autoencoder.onnx  +  artifacts/metrics.json  +  data/replay.csv
   │
   ▼
Java Spring Boot API :8080      POST /score · GET /health · GET /metrics   (ONNX Runtime for Java)
   ▲
   │ one transaction at a time, 3/s
Node.js replay server :8081     plays data/replay.csv, WebSocket /ws, running totals, demo mode
   │ WebSocket
   ▼
React + TypeScript dashboard :5173
```

## Quick start

Requirements: macOS or Linux, Java 17+, Node.js 18+. Python is only needed to retrain.

```bash
./start.sh
```

`start.sh` checks prerequisites and builds anything missing: the Java jar, npm packages
from the lock files, and the dashboard. It then starts the API, the replay server and the
dashboard in order, waiting for each health check, and opens http://localhost:5173.
While it runs it keeps the Mac awake and restarts any service that crashes. Ctrl+C stops
everything. If a terminal was closed without Ctrl+C, run `./stop.sh`.

Useful options:
- `./start.sh --no-open` starts without opening a browser.
- `http://localhost:5173/?theme=light` (or `?theme=dark`) forces a color theme.

Logs are in `logs/`. See [DEMO_CHECKLIST.md](DEMO_CHECKLIST.md) for the presentation run-of-show and
what to do if something fails live.

## Repository layout

| Path | What it is |
|---|---|
| `ml/train.py` | Phase 1: training, threshold choice, evaluation, ONNX export, replay file |
| `artifacts/` | The trained model (`fraud_autoencoder.onnx`, `fraud_scorer.pt`) and `metrics.json` |
| `data/replay.csv` | The demo stream: every test-set fraud case plus 2,000 sampled normal test transactions |
| `api/` | Phase 2: Spring Boot scoring API and its tests |
| `replay/` | Phase 3: Node.js replay server and its tests |
| `dashboard/` | Phase 4: React dashboard and its tests |
| `start.sh`, `stop.sh` | Phase 5: one-command start and cleanup |
| `DEMO_CHECKLIST.md` | Presentation checklist, run-of-show, and what to do if something fails live |
| `docs/screenshots/` | Captures of the running dashboard, a backup if the live demo can't run |

`data/creditcard.csv` isn't committed because of its size (151 MB); download it from Kaggle
(see [Data source and credit](#data-source-and-credit)). It's only needed to retrain.

## How the metrics were derived

Every number below comes from `artifacts/metrics.json`, which `ml/train.py` writes by
running on the real data. The script is deterministic (fixed seeds, single-threaded),
so rerunning it reproduces the file byte for byte.

### 1. Data and split

The dataset has 284,807 card transactions over about 48 hours, 492 of them fraud (0.17%).
`V1`–`V28` are anonymized features supplied by the dataset's publishers; `Time` is
seconds since the first transaction.

The data is split **chronologically by `Time`, with no shuffling**: train on the past,
evaluate on the future, which is how the model would be used.

| Split | Rows | Fraud | Time range (s) |
|---|---|---|---|
| Train (first 60%) | 170,882 | 360 | 0 – 120,395 |
| Validation (next 20%) | 56,963 | 57 | 120,396 – 145,247 |
| Test (last 20%) | 56,962 | 75 | 145,248 – 172,792 |

The split cuts at timestamps, so identical rows (the dataset has 1,081 exact duplicates)
can't land on both sides of a cut.

### 2. Features

- `V1`–`V28` as provided
- `log(1 + Amount)`: amounts are heavily skewed (training median $21.89, max $19,656.53)
- Time of day as `sin` and `cos` of `Time mod 24h`, so 11:59 pm and 12:01 am are neighbors.
  This assumes the data starts at midnight; `Time` is relative, not clock time.

All 31 features are standardized with means and standard deviations computed **on the
training split only**, so no statistics from the validation or test periods leak in.

### 3. Model

An autoencoder (31 → 16 → 8 → 16 → 31, ReLU) trained with mean squared error to rebuild
**normal training transactions only**: 153,470 of them, with 17,052 more held back for
early stopping. Fraud labels are used once, to filter out the 360 training fraud cases;
they're never a training target. Training stops after 5 epochs without improvement on the
held-back normals and keeps the best epoch. The validation set isn't used for this.

**Fraud score = reconstruction error** (mean squared error across the 31 scaled features).
A higher score means the transaction looks less like normal activity.

### 4. Threshold

The alert threshold is the score that **maximizes F1 on the validation set**: **6.7455**.
The test set played no part in choosing it. On validation it flagged 0.71% of
transactions, with recall 47.4% and precision 6.7%.

### 5. Results on the held-out test set

The test set was scored once, with the threshold fixed beforehand.

| Metric | Value |
|---|---|
| Fraud cases caught (recall) | **41.3%** (31 of 75) |
| Transactions flagged (alert rate) | **0.41%** (235 of 56,962) |
| Alerts that were real fraud (precision) | **13.2%**, about 1 in 8 |
| Fraud base rate | 0.13%, about 1 in 760 |
| Precision vs. base rate | about 100× |
| Fraud dollars caught | **$484.50 of $7,729.26 (6.3%)** |
| Confusion counts | TP 31 · FP 204 · FN 44 · TN 56,683 |
| ROC-AUC / average precision | 0.968 / 0.083 (random ranking would score 0.0013 average precision) |

The dashboard's business impact panel computes its sentences from these values at run time.

**Limitations, stated plainly:**

- **Fraud dollars are low because "unusual" isn't the same as "fraud."** The model
  catches many small card-testing charges (45 of the 75 test frauds are $10 or less) but
  missed the five largest frauds, which account for 60% of fraud dollars. Large
  legitimate purchases also score high: the top 100 validation scores contained 1 fraud,
  with a median amount of $519. A supervised model or high-value rules would complement it.
- **The test set is small.** With 75 fraud cases, each one moves recall by 1.3 points.
- **Behavior shifts over time.** The same threshold flagged 0.71% of validation transactions
  but 0.41% of test transactions.
- **Two days of anonymized data.** There's no merchant, device or location data, and the
  model can't explain its alerts in business terms.

### 6. Threshold trade-off (test set)

Each row's threshold was set from the **validation** score distribution at a target alert
rate, then applied unchanged to the test set. This shows the trade-off without picking a
point by looking at test results.

| Test alerts | Fraud cases caught | Precision | Fraud dollars caught |
|---|---|---|---|
| 0.13% | 0.0% | 0.0% | 0.0% |
| 0.28% | 28.0% | 13.0% | 2.7% |
| **0.41% (chosen)** | **41.3%** | **13.2%** | **6.3%** |
| 0.65% | 50.7% | 10.3% | 19.4% |
| 1.02% | 66.7% | 8.6% | 56.5% |
| 1.44% | 77.3% | 7.0% | 68.4% |
| 4.14% | 85.3% | 2.7% | 69.3% |
| 9.21% | 88.0% | 1.3% | 69.6% |

The full sweep is in `metrics.json` under `threshold_sweep`. Note that the very highest
scores are all false alarms: the first fraud appears only once about 0.18% of
transactions are flagged.

## How serving was verified

- **Python → ONNX:** the exported model matches PyTorch on the whole test set (max relative
  difference 9.5 × 10⁻⁷). Feature engineering and scaling are inside the ONNX file, so
  Java sends raw `Time, V1..V28, Amount`.
- **Python → Java:** `ScoringParityTest` scores all 2,075 replay rows in Java and compares
  them with Python's scores: max relative difference 2.13 × 10⁻⁷, and identical alert
  decisions on every row.
- **Speed (Apple Silicon laptop, no network):** over 500 sequential requests, scoring took a
  median 0.035 ms and the full HTTP round trip a median 0.44 ms.

## The demo stream

`data/replay.csv` holds all 75 test-set fraud cases plus 2,000 randomly sampled normal
test transactions, so fraud is about 3.6% of the stream versus 0.13% in reality. The
dashboard therefore shows **counts only, never rates**, for the stream, and labels it as a
fraud-enriched sample.

In demo mode one real fraud case is moved to play 20 seconds after the stream starts or
restarts. It's chosen by a fixed rule: the largest-dollar fraud that Phase 1 scored at
least 1.25× the threshold (replay row 1293, $127.14). Everything else plays in its real
order, including misses and false alarms. At 3 transactions per second the stream lasts
about 11.5 minutes, then starts over.

The dashboard shows whether each transaction was really fraud immediately. Banks
usually learn that weeks later, from chargebacks.

## Data source and credit

This project uses the **[Credit Card Fraud Detection](https://www.kaggle.com/datasets/mlg-ulb/creditcardfraud)**
dataset published on Kaggle by the **Machine Learning Group, Université Libre de Bruxelles (ULB)**
(`mlg-ulb`). The dataset was collected and analysed during a research collaboration between
Worldline and the ULB Machine Learning Group on big data mining and fraud detection.

- **License:** Open Database License (ODbL) for the database and Database Contents License
  (DbCL) for its contents, as listed on the dataset page.
- **What's in this repository:** the full dataset is *not* included. `data/replay.csv` is a
  2,075-row subset derived from it (the test-period rows described above, plus the model's
  scores), shared under the same terms with this attribution.

The dataset's authors ask that the following works be cited (the full list is on the
[dataset page](https://www.kaggle.com/datasets/mlg-ulb/creditcardfraud)):

- Andrea Dal Pozzolo, Olivier Caelen, Reid A. Johnson and Gianluca Bontempi. *Calibrating
  Probability with Undersampling for Unbalanced Classification.* Symposium on Computational
  Intelligence and Data Mining (CIDM), IEEE, 2015.
- Andrea Dal Pozzolo, Olivier Caelen, Yann-Aël Le Borgne, Serge Waterschoot, Gianluca Bontempi.
  *Learned lessons in credit card fraud detection from a practitioner perspective.* Expert
  Systems with Applications, 41(10), 4915–4928, 2014.
- Andrea Dal Pozzolo, Giacomo Boracchi, Olivier Caelen, Cesare Alippi, Gianluca Bontempi.
  *Credit card fraud detection: a realistic modeling and a novel learning strategy.* IEEE
  Transactions on Neural Networks and Learning Systems, 29(8), 3784–3797, 2018.

## Tests

```bash
cd api && mvn test            # 9 tests, including Java vs. Python parity
cd replay && npm test         # 15 tests, including API outage recovery
cd dashboard && npm test      # 12 tests, including the panel sentences from metrics.json
```

## Retraining

```bash
python3 -m venv .venv && .venv/bin/pip install -r ml/requirements.txt
.venv/bin/python ml/train.py
```

This rewrites `artifacts/` and `data/replay.csv`. The Java parity test then confirms the API
still matches Python, and the dashboard picks up the new numbers automatically.
