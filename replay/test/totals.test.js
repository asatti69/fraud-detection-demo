import assert from 'node:assert/strict';
import { test } from 'node:test';
import { addToTotals, emptyTotals, outcome } from '../src/totals.js';

test('outcome labels', () => {
  assert.equal(outcome(true, 1), 'TP');
  assert.equal(outcome(false, 1), 'FN');
  assert.equal(outcome(true, 0), 'FP');
  assert.equal(outcome(false, 0), 'TN');
});

test('totals accumulate counts and fraud dollars', () => {
  let t = emptyTotals();
  t = addToTotals(t, { amount: 127.14, flagged: true, label: 1 }); // caught fraud
  t = addToTotals(t, { amount: 50, flagged: false, label: 1 }); // missed fraud
  t = addToTotals(t, { amount: 900, flagged: true, label: 0 }); // false alarm
  t = addToTotals(t, { amount: 20.1, flagged: false, label: 0 }); // normal
  assert.deepEqual(t, {
    scored: 4,
    flagged: 2,
    tp: 1,
    fp: 1,
    fn: 1,
    tn: 1,
    amountScored: 1097.24,
    fraudDollarsSeen: 177.14,
    fraudDollarsCaught: 127.14,
  });
});

test('totals are not mutated in place', () => {
  const t = emptyTotals();
  addToTotals(t, { amount: 1, flagged: true, label: 1 });
  assert.equal(t.scored, 0);
});
