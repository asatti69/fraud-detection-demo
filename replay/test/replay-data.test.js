import assert from 'node:assert/strict';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { buildSequence, FEATURES, loadReplay, pickDemoFraud } from '../src/replay-data.js';

const CSV = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'data', 'replay.csv');
const THRESHOLD = 6.745466810943141; // artifacts/metrics.json
const rows = loadReplay(CSV);

test('replay.csv has every test-set fraud case plus 2,000 normals', () => {
  assert.equal(rows.length, 2075);
  assert.equal(rows.filter((r) => r.label === 1).length, 75);
  assert.deepEqual(Object.keys(rows[0].features), FEATURES);
  assert.equal(FEATURES.length, 30);
});

test('rows are in time order', () => {
  for (let i = 1; i < rows.length; i++) assert.ok(rows[i].time >= rows[i - 1].time);
});

test('demo fraud is the largest-dollar fraud caught with at least a 1.25x margin', () => {
  const pick = pickDemoFraud(rows, THRESHOLD);
  assert.equal(pick.label, 1);
  assert.equal(pick.replayRow, 1293);
  assert.equal(pick.amount, 127.14);
  assert.ok(pick.pythonScore >= THRESHOLD * 1.25);
});

test('demo mode moves only the demo fraud, to the slot that plays at 20 seconds', () => {
  for (const rate of [2, 3, 5]) {
    const { sequence, demoFraud, demoPosition } = buildSequence(rows, { mode: 'demo', rate, threshold: THRESHOLD });
    assert.equal(demoPosition, 20 * rate);
    assert.equal(sequence[demoPosition], demoFraud);
    assert.equal(sequence.length, rows.length);
    assert.equal(new Set(sequence).size, rows.length, 'every row exactly once');
    const others = sequence.filter((r) => r !== demoFraud);
    assert.deepEqual(others, rows.filter((r) => r !== demoFraud), 'everything else stays in time order');
  }
});

test('nothing is flagged by Phase 1 before the demo fraud at 3 tx/s', () => {
  const { sequence, demoPosition } = buildSequence(rows, { mode: 'demo', rate: 3, threshold: THRESHOLD });
  const before = sequence.slice(0, demoPosition);
  assert.equal(before.filter((r) => r.pythonScore >= THRESHOLD).length, 0);
});

test('replay mode keeps the original order', () => {
  const { sequence, demoFraud } = buildSequence(rows, { mode: 'replay', rate: 3, threshold: THRESHOLD });
  assert.equal(sequence, rows);
  assert.equal(demoFraud, null);
});
