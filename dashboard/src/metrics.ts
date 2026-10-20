// Turns artifacts/metrics.json into the business impact panel's sentences and the
// trade-off chart's points. Every number comes from the file; nothing is hardcoded.
import { count, money, oneIn, pct, roundSig } from './format.ts';
import type { Metrics } from './types.ts';

export interface ImpactSummary {
  headline: string;
  alertQuality: string;
  detail: string;
  dollarsCaught: string;
  dollarsTotal: string;
  dollarsPct: string;
}

export function impactSummary(m: Metrics): ImpactSummary {
  const t = m.test;
  const baseRate = m.test_threshold_free.fraud_base_rate;
  const frauds = t.tp + t.fn;

  const alertQuality =
    t.precision && t.precision > 0
      ? `About 1 in ${oneIn(1 / t.precision)} alerts is real fraud, vs. a 1 in ${count(oneIn(1 / baseRate))} base rate, ` +
        `so an alert is ~${roundSig(t.precision / baseRate, 2)}× more likely to be fraud than a random transaction.`
      : 'No alerts were raised on the test data at this threshold.';

  return {
    headline: `Caught ${pct(t.recall ?? 0)} of fraud cases while flagging ${pct(t.alert_rate)} of transactions`,
    alertQuality,
    detail: `${t.tp} of ${frauds} fraud cases · ${count(t.alerts)} alerts in ${count(t.n_transactions)} transactions`,
    dollarsCaught: money(t.fraud_dollars_caught),
    dollarsTotal: money(t.fraud_dollars_total),
    dollarsPct: pct(t.fraud_dollars_caught_pct ?? 0),
  };
}

export interface TradeoffPoint {
  alertRate: number;
  casesCaught: number;
  dollarsCaught: number;
  threshold: number;
  current: boolean;
}

/**
 * Points for the trade-off chart: every threshold in the sweep plus the current one, measured
 * on test data. All thresholds were set on validation data. Points that flag nothing are dropped
 * because the chart's x-axis is logarithmic.
 */
export function tradeoffPoints(m: Metrics): TradeoffPoint[] {
  const toPoint = (r: Metrics['test'], current: boolean): TradeoffPoint => ({
    alertRate: r.alert_rate,
    casesCaught: r.recall ?? 0,
    dollarsCaught: r.fraud_dollars_caught_pct ?? 0,
    threshold: r.threshold,
    current,
  });
  return [...m.threshold_sweep.map((s) => toPoint(s.test, false)), toPoint(m.test, true)]
    .filter((p) => p.alertRate > 0)
    .sort((a, b) => a.alertRate - b.alertRate);
}

export interface SensitivitySteps {
  points: TradeoffPoint[];
  /** Index of the threshold chosen on validation data (the live threshold). */
  defaultIndex: number;
}

/** The slider's snap points: every trade-off point, ordered from fewest to most alerts. */
export function sensitivitySteps(m: Metrics): SensitivitySteps {
  const points = tradeoffPoints(m);
  return { points, defaultIndex: points.findIndex((p) => p.current) };
}

export interface WhatIfReadout {
  threshold: string;
  casesCaught: string;
  dollarsCaught: string;
  alertsPer100k: string;
}

export function whatIfReadout(p: TradeoffPoint): WhatIfReadout {
  return {
    threshold: p.threshold.toFixed(2),
    casesCaught: pct(p.casesCaught),
    dollarsCaught: pct(p.dollarsCaught),
    alertsPer100k: count(Math.round(p.alertRate * 100_000)),
  };
}
