import { useState } from 'react';
import { count, money } from '../format.ts';
import type { StreamState } from '../stream.ts';

/** One-line disclosure, with the full explanation behind an "About this stream" toggle. */
export function StreamHeader({ stream }: { stream: StreamState }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="stream-head">
      <div className="stream-head-row">
        <h2 id="stream-heading">Demo stream (fraud-enriched sample)</h2>
        <button type="button" className="link-button" aria-expanded={open} aria-controls="stream-about" onClick={() => setOpen(!open)}>
          ⓘ About this stream
        </button>
      </div>
      <p className="muted">Counts only, not rates.</p>
      {open && (
        <div id="stream-about" className="about">
          {stream.replay && (
            <p>
              The stream holds all {count(stream.replay.fraud)} fraud cases from the held-out test data plus{' '}
              {count(stream.replay.transactions - stream.replay.fraud)} randomly sampled normal transactions, so fraud is far
              more common here than in real traffic. That's why it shows counts, never rates; the results on the right are
              the ones to judge the model by.
            </p>
          )}
          <p>Whether each transaction was really fraud is shown instantly for the demo. Banks usually learn it weeks later, from chargebacks.</p>
          {stream.demoFraud && stream.config?.mode === 'demo' && (
            <p>
              Demo mode: one real test-set fraud case ({money(stream.demoFraud.amount)}) is moved to play at{' '}
              {Math.round(stream.demoFraud.playsAtSeconds)} seconds. Everything else plays in its real order.
            </p>
          )}
        </div>
      )}
    </div>
  );
}

/**
 * Running counts for the replay, in one compact row. Deliberately counts only, never rates:
 * the replay is enriched with fraud, so a rate here would overstate real-world performance.
 */
export function StreamCounters({ stream }: { stream: StreamState }) {
  const t = stream.totals;
  const tiles: { label: string; value: string; sub?: string; tone?: 'critical' | 'warning' }[] = [
    { label: 'Scored', value: t ? count(t.scored) : '–' },
    { label: 'Alerts', value: t ? count(t.flagged) : '–' },
    { label: 'False alarms', value: t ? count(t.fp) : '–' },
    { label: 'Fraud caught', value: t ? count(t.tp) : '–', tone: 'critical' },
    { label: 'Fraud missed', value: t ? count(t.fn) : '–', tone: 'warning' },
    { label: 'Fraud $ caught', value: t ? money(t.fraudDollarsCaught) : '–', sub: t ? `of ${money(t.fraudDollarsSeen)} seen` : undefined },
  ];

  return (
    <div className="counters" aria-label="Demo stream counts">
      {tiles.map((tile) => (
        <div className="counter" key={tile.label}>
          <div className="counter-label">
            {tile.tone && <span className={`key-dot tone-${tile.tone}`} aria-hidden="true" />}
            {tile.label}
          </div>
          <div className="counter-value">{tile.value}</div>
          {tile.sub && <div className="counter-of">{tile.sub}</div>}
        </div>
      ))}
    </div>
  );
}
