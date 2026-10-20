// Loads data/replay.csv and decides the order transactions are played in.
import { readFileSync } from 'node:fs';

/** Fields the scoring API expects, in model order: Time, V1..V28, Amount. */
export const FEATURES = ['Time', ...Array.from({ length: 28 }, (_, i) => `V${i + 1}`), 'Amount'];

/**
 * Parses replay.csv (written by ml/train.py). Each row keeps its true label and
 * Phase 1's Python score; neither is sent to the API.
 */
export function parseReplayCsv(text) {
  const [headerLine, ...lines] = text.trim().split('\n');
  const header = headerLine.split(',');
  const col = (name) => {
    const i = header.indexOf(name);
    if (i < 0) throw new Error(`replay.csv is missing column ${name}`);
    return i;
  };
  const featureCols = FEATURES.map(col);
  const classCol = col('Class');
  const scoreCol = col('score');

  return lines.map((line, index) => {
    const cells = line.split(',');
    const features = Object.fromEntries(FEATURES.map((name, i) => [name, Number(cells[featureCols[i]])]));
    return {
      replayRow: index,
      features,
      time: features.Time,
      amount: features.Amount,
      label: Number(cells[classCol]),
      pythonScore: Number(cells[scoreCol]),
    };
  });
}

export function loadReplay(path) {
  return parseReplayCsv(readFileSync(path, 'utf8'));
}

/**
 * Picks the fraud case for the scripted demo moment, by a fixed written-down rule:
 * the largest-dollar fraud that Phase 1 scored at least `minMargin` x the threshold,
 * so it is a real, clearly caught case rather than one that barely crosses the line.
 */
export function pickDemoFraud(rows, threshold, minMargin = 1.25) {
  const candidates = rows.filter((r) => r.label === 1 && r.pythonScore >= threshold * minMargin);
  if (candidates.length === 0) throw new Error('No fraud case clears the demo margin');
  return candidates.reduce((best, r) => (r.amount > best.amount ? r : best));
}

/**
 * Returns the play order. "replay" plays rows in time order. "demo" plays them in time
 * order too, except one real fraud case is moved so it plays at `demoAtSeconds`.
 */
export function buildSequence(rows, { mode, rate, threshold, demoAtSeconds = 20 }) {
  if (mode !== 'demo') return { sequence: rows, demoFraud: null, demoPosition: null };
  const demoFraud = pickDemoFraud(rows, threshold);
  const demoPosition = Math.min(Math.round(demoAtSeconds * rate), rows.length - 1);
  const sequence = rows.filter((r) => r !== demoFraud);
  sequence.splice(demoPosition, 0, demoFraud);
  return { sequence, demoFraud, demoPosition };
}
