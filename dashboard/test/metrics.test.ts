// Checks the business impact sentences against the real artifacts/metrics.json.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { oneIn, pct, roundSig } from '../src/format.ts';
import { impactSummary, tradeoffPoints } from '../src/metrics.ts';
import type { Metrics } from '../src/types.ts';

const metrics: Metrics = JSON.parse(readFileSync(new URL('../../artifacts/metrics.json', import.meta.url), 'utf8'));

test('headline reads the held-out test results', () => {
  assert.equal(impactSummary(metrics).headline, 'Caught 41% of fraud cases while flagging 0.4% of transactions');
});

test('alert quality line is computed from precision and the base rate', () => {
  assert.equal(
    impactSummary(metrics).alertQuality,
    'About 1 in 8 alerts is real fraud, vs. a 1 in 760 base rate, so an alert is ~100× more likely to be fraud than a random transaction.',
  );
});

test('fraud dollars are reported in full', () => {
  const s = impactSummary(metrics);
  assert.equal(s.dollarsCaught, '$484.50');
  assert.equal(s.dollarsTotal, '$7,729.26');
  assert.equal(s.dollarsPct, '6.3%');
  assert.equal(s.detail, '31 of 75 fraud cases · 235 alerts in 56,962 transactions');
});

test('sentences follow the numbers when metrics change', () => {
  const changed: Metrics = structuredClone(metrics);
  changed.test.recall = 0.667;
  changed.test.alert_rate = 0.0102;
  changed.test.precision = 0.086;
  assert.equal(impactSummary(changed).headline, 'Caught 67% of fraud cases while flagging 1% of transactions');
  assert.match(impactSummary(changed).alertQuality, /1 in 12 alerts.*~65×/);
});

test('trade-off points: whole sweep plus the current threshold, sorted, none at 0% flagged', () => {
  const points = tradeoffPoints(metrics);
  assert.equal(points.length, metrics.threshold_sweep.length + 1);
  assert.equal(points.filter((p) => p.current).length, 1);
  const current = points.find((p) => p.current)!;
  assert.equal(current.alertRate, metrics.test.alert_rate);
  assert.equal(current.casesCaught, metrics.test.recall);
  for (let i = 1; i < points.length; i++) assert.ok(points[i].alertRate >= points[i - 1].alertRate);
});

test('formatting helpers', () => {
  assert.equal(pct(0.41333), '41%');
  assert.equal(pct(0.004125), '0.4%');
  assert.equal(pct(0.0626), '6.3%');
  assert.equal(pct(0.0002), '0.02%');
  assert.equal(pct(0), '0%');
  assert.equal(oneIn(7.58), 8);
  assert.equal(oneIn(759.49), 760);
  assert.equal(roundSig(100.19), 100);
});
