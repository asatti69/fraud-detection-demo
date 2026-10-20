# Live demo checklist

## The day before

- [ ] Run `./start.sh` and watch the whole stream for a minute. Fix anything now, not on Friday.
- [ ] Run the three test suites (see README → Tests).
- [ ] Look at the dashboard on the screen or projector you'll use, if you can. Decide light or
      dark: `http://localhost:5173/?theme=light` forces light mode.
- [ ] Have the backup ready: `docs/screenshots/` has full-page captures of the running
      dashboard. Open them once so you know where they are.

## 15 minutes before

- [ ] Plug in the charger.
- [ ] Quit apps you don't need. Turn on **Do Not Disturb** so notifications don't appear on a shared screen.
- [ ] `./start.sh`, and wait for "Demo is running".
- [ ] Put the browser in **full screen** (Ctrl+Cmd+F). At 1440×900 the chart and counters fit
      without scrolling; on a smaller screen use browser zoom 90% (Cmd+minus).
- [ ] If you're screen sharing, share the **browser window**, not the whole screen.

## Right before you start

- [ ] Press **Restart** on the dashboard. The scripted fraud ($127.14) plays **20 seconds**
      after Restart, and the stream runs about 11.5 minutes before looping. Restart also returns
      the Sensitivity slider to its default.

## Run of show (about 7 minutes)

| Time | Show | Say |
|---|---|---|
| 0:00 | Press Restart. Point to the right panel. | "Before the live part, here's how the model did on data it never saw: the latest 20% of transactions." Read the headline. |
| 0:20 | The $127.14 "Demo case" turns red above the threshold. | "That's a real fraud case from the test data. I've moved it to play now so we don't wait, and it's scored live by the Java service." |
| 1:00 | Counters, feed, Recent alerts. | "False alarms and misses show up too. Blue diamonds below the line are frauds it let through. This stream is enriched with fraud, so it shows counts, not rates." |
| 2:30 | "About 1 in 8 alerts…" line. | "An alert is about 100 times more likely to be fraud than a random transaction. That's what decides analyst productivity." |
| 3:30 | Fraud dollars. | "Only 6% of fraud dollars. 'Unusual' isn't 'fraud': big legitimate purchases score high too. I'd pair this with a supervised model for high-value transactions." |
| 4:30 | Drag the **Sensitivity** slider to about 1%. | "The threshold is your decision. Flag 1% and you catch two-thirds of cases, at about 1,000 alerts per 100,000 transactions. Your alert capacity picks the point. This is a what-if on the same held-out data; live alerts keep using the default." |
| 5:30 | Architecture (header line, or README). | "Trained in Python, shipped as one ONNX file, scored in Java, the stack you already run. A test proves Java matches Python on every replay transaction." |
| 6:30 | Pause. | Questions. |

## What could fail, and what to do

| # | Symptom | Likely cause | What to do live |
|---|---|---|---|
| 1 | `start.sh`: "Port 8080 is already in use" | An earlier run is still going, e.g. a closed terminal | `./stop.sh`, then `./start.sh` |
| 2 | `start.sh`: "Java 17+ not found" or "Node.js 18+ not found" | The terminal didn't load your shell profile | `source ~/.zshrc`, then `./start.sh` (it also looks in `~/tools` itself) |
| 3 | Red pill "Scoring API unavailable, retrying" | The Java API crashed or hung | Nothing: `start.sh` restarts it, and the stream resumes on the same transaction. Say: "That's the outage handling: it pauses and resumes without skipping." |
| 4 | Pill stuck on "Connecting to replay server…" | Replay server down | `start.sh` restarts it automatically within a few seconds. The stream starts over, so press Restart for the scripted case. |
| 5 | Panel stuck on "Loading test results…" | `/metrics` unreachable because the API is down | It retries every 2 seconds and fills in once the API is back. |
| 6 | Browser shows "can't connect" | The dashboard server stopped, or `start.sh` was closed | Check the terminal. `start.sh` restarts a crashed dashboard; if the script itself stopped, run it again. |
| 7 | The scripted fraud already played | More than 20 seconds passed since the start or last Restart | Press **Restart**. |
| 8 | Counters reset to 0 mid-demo | The stream reached its end (about 11.5 minutes) and looped | Press Restart before presenting. If it happens, say "the replay just looped" and continue. |
| 9 | Chart below the fold, text too small or too big | Screen resolution differs from 1440×900 | Full screen (Ctrl+Cmd+F) and browser zoom (Cmd+minus / Cmd+plus). |
| 10 | Washed-out colors on a projector | Dark mode on a bright projector | Add `?theme=light` to the URL. |
| 11 | Old layout or odd behavior after an update | Browser cached an old build | Hard refresh: Cmd+Shift+R. |
| 12 | Mac goes to sleep or the screen dims | Power settings | `start.sh` keeps the Mac awake while it runs (`caffeinate`). Keep the charger in. |
| 13 | Notification pops up while sharing | Do Not Disturb is off | Turn it on beforehand. |
| 14 | Wi-Fi drops | – | Nothing: everything runs locally and needs no internet. |
| 15 | First build takes long or fails | Missing packages on a fresh machine (`npm ci` or Maven needs the internet) | Run `./start.sh` once the day before, so everything is built and cached. |
| 16 | Interviewer asks to change the threshold live | The slider is display-only by design | Move the Sensitivity slider and read the what-if numbers. Explain that the live API threshold changes only through a reviewed release, which is how a bank would want it. |
| 17 | Everything fails | – | Show `docs/screenshots/` and walk through the same story. Say what you'd check. Calm recovery is part of the job. |

## Questions to expect

- **"Why not just accuracy?"** 99.87% of transactions are legitimate, so a model that never
  flags anything is 99.87% accurate. Precision and recall at a chosen alert rate are what matter.
- **"Why is ROC-AUC 0.97 but average precision only 0.08?"** ROC-AUC measures false alarms
  against all 56,887 legitimate transactions, so it always looks good on rare events.
  Average precision measures them against the alerts themselves. 0.08 is about 63× better
  than random (0.0013).
- **"Is the test fair?"** It's chronological: trained on earlier transactions, tested on the
  latest. The threshold was chosen on validation data, and the test set was scored once.
- **"What would you do next?"** Add a supervised model for known fraud patterns, rank
  alerts by expected dollar loss, and pilot on the bank's own data with real features
  (merchant, device, location, velocity) and chargeback feedback.
