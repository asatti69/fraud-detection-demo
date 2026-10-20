import { impactSummary } from '../metrics.ts';
import type { SensitivitySteps } from '../metrics.ts';
import type { Metrics } from '../types.ts';
import { TradeoffChart } from './TradeoffChart.tsx';
import { WhatIfSlider } from './WhatIfSlider.tsx';

interface Props {
  metrics: Metrics | null;
  error: string | null;
  steps: SensitivitySteps | null;
  whatIfIndex: number;
  onWhatIfChange: (i: number) => void;
}

/** Business impact, from artifacts/metrics.json only (held-out test results). The headline never follows the slider. */
export function ImpactPanel({ metrics, error, steps, whatIfIndex, onWhatIfChange }: Props) {
  if (!metrics || !steps) {
    return (
      <section className="card impact" aria-busy="true">
        <p className="eyebrow">Results on held-out test data</p>
        <p className="muted">{error ? `Loading test results… (${error}, retrying)` : 'Loading test results…'}</p>
      </section>
    );
  }
  const s = impactSummary(metrics);

  return (
    <section className="card impact" aria-labelledby="impact-heading">
      <p className="eyebrow">Results on held-out test data</p>
      <h2 id="impact-heading" className="headline">{s.headline}</h2>
      <p className="impact-line">{s.alertQuality}</p>
      <p className="muted">{s.detail}. Test data is the latest 20% of transactions by time, never used for training or for choosing the threshold.</p>

      <div className="dollars">
        <div className="counter-label">Fraud dollars caught</div>
        <div className="dollars-value">
          {s.dollarsCaught} <span className="counter-of">of {s.dollarsTotal} ({s.dollarsPct})</span>
        </div>
        <p className="muted">Unusual isn't always fraud: large legitimate purchases also score high.</p>
      </div>

      <WhatIfSlider steps={steps} index={whatIfIndex} onChange={onWhatIfChange} />
      <TradeoffChart points={steps.points} selected={steps.points[whatIfIndex]} />
    </section>
  );
}
