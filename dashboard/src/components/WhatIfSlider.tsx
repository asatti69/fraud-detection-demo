import { pct } from '../format.ts';
import { whatIfReadout } from '../metrics.ts';
import type { SensitivitySteps } from '../metrics.ts';

/**
 * Display-only sensitivity slider. It snaps to the threshold sweep in metrics.json and changes
 * only what is drawn; the API's live alert decisions keep using the validation-chosen threshold.
 */
export function WhatIfSlider({ steps, index, onChange }: { steps: SensitivitySteps; index: number; onChange: (i: number) => void }) {
  const selected = steps.points[index];
  const defaultPoint = steps.points[steps.defaultIndex];
  const r = whatIfReadout(selected);
  const isDefault = index === steps.defaultIndex;

  return (
    <div className="whatif">
      <div className="whatif-head">
        <h3>Sensitivity</h3>
        <button type="button" className="link-button" disabled={isDefault} onClick={() => onChange(steps.defaultIndex)}>
          Reset to default
        </button>
      </div>
      <p className="muted">What-if on held-out test data. The default was chosen on validation data.</p>

      <input
        type="range"
        min={0}
        max={steps.points.length - 1}
        step={1}
        value={index}
        onChange={(e) => onChange(Number(e.target.value))}
        aria-label="Alert threshold setting"
        aria-valuetext={`${pct(selected.alertRate)} of transactions flagged, threshold ${r.threshold}`}
      />
      <div className="whatif-ends muted" aria-hidden="true">
        <span>Fewer alerts</span>
        <span>Catch more fraud</span>
      </div>

      <div className="whatif-readout" aria-live="polite">
        <div>
          <div className="counter-label">Fraud cases caught</div>
          <div className="readout-value">{r.casesCaught}</div>
        </div>
        <div>
          <div className="counter-label">Fraud dollars caught</div>
          <div className="readout-value">{r.dollarsCaught}</div>
        </div>
        <div>
          <div className="counter-label">Alerts per 100,000</div>
          <div className="readout-value">{r.alertsPer100k}</div>
        </div>
      </div>
      <p className="muted whatif-note">
        Threshold {r.threshold}
        {isDefault ? ' (default)' : ` vs. default ${defaultPoint.threshold.toFixed(2)}`}. Live alerts in the demo stream
        always use the default.
      </p>
    </div>
  );
}
