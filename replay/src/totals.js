// Running totals for the replay. These describe the replay stream only; the replay is
// enriched with fraud (all 75 test-set frauds + 2,000 normals), so they are not
// performance metrics. Held-out test metrics come from GET /metrics.

/** TP: fraud flagged. FP: legitimate flagged. FN: fraud missed. TN: legitimate passed. */
export function outcome(flagged, label) {
  if (label === 1) return flagged ? 'TP' : 'FN';
  return flagged ? 'FP' : 'TN';
}

export function emptyTotals() {
  return {
    scored: 0,
    flagged: 0,
    tp: 0,
    fp: 0,
    fn: 0,
    tn: 0,
    amountScored: 0,
    fraudDollarsSeen: 0,
    fraudDollarsCaught: 0,
  };
}

/** Returns new totals with one scored transaction added. */
export function addToTotals(totals, { amount, flagged, label }) {
  const kind = outcome(flagged, label);
  return {
    scored: totals.scored + 1,
    flagged: totals.flagged + (flagged ? 1 : 0),
    tp: totals.tp + (kind === 'TP' ? 1 : 0),
    fp: totals.fp + (kind === 'FP' ? 1 : 0),
    fn: totals.fn + (kind === 'FN' ? 1 : 0),
    tn: totals.tn + (kind === 'TN' ? 1 : 0),
    amountScored: round2(totals.amountScored + amount),
    fraudDollarsSeen: round2(totals.fraudDollarsSeen + (label === 1 ? amount : 0)),
    fraudDollarsCaught: round2(totals.fraudDollarsCaught + (kind === 'TP' ? amount : 0)),
  };
}

function round2(x) {
  return Math.round(x * 100) / 100;
}
