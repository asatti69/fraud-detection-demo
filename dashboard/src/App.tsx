import { useEffect, useMemo, useState } from 'react';
import { Header } from './components/Header.tsx';
import { ImpactPanel } from './components/ImpactPanel.tsx';
import { RecentAlerts } from './components/RecentAlerts.tsx';
import { ScoreChart } from './components/ScoreChart.tsx';
import { StreamCounters, StreamHeader } from './components/StreamCounters.tsx';
import { TransactionFeed } from './components/TransactionFeed.tsx';
import { useMetrics, useReplayStream } from './connections.ts';
import { sensitivitySteps } from './metrics.ts';

export function App() {
  const { stream, control } = useReplayStream();
  const { metrics, error } = useMetrics();
  const threshold = stream.model?.threshold ?? metrics?.threshold ?? null;

  // Sensitivity slider: display-only, never sent to the server. null = the validation-chosen default.
  const steps = useMemo(() => (metrics ? sensitivitySteps(metrics) : null), [metrics]);
  const [whatIfIndex, setWhatIfIndex] = useState<number | null>(null);
  useEffect(() => setWhatIfIndex(null), [stream.resets]); // Restart (or a replay loop) resets it
  const index = steps ? (whatIfIndex ?? steps.defaultIndex) : 0;
  const whatIfThreshold = steps && whatIfIndex !== null ? steps.points[index].threshold : null;

  return (
    <div className="app">
      <Header stream={stream} onControl={control} />
      <main className="layout">
        <div className="column">
          <section className="card stream-card" aria-labelledby="stream-heading">
            <StreamHeader stream={stream} />
            <ScoreChart events={stream.events} threshold={threshold} whatIfThreshold={whatIfThreshold} />
            <StreamCounters stream={stream} />
          </section>
          <div className="card">
            <TransactionFeed events={stream.events} />
          </div>
        </div>
        <div className="column">
          <ImpactPanel metrics={metrics} error={error} steps={steps} whatIfIndex={index} onWhatIfChange={(i) => setWhatIfIndex(steps && i === steps.defaultIndex ? null : i)} />
          <div className="card">
            <RecentAlerts alerts={stream.alerts} />
          </div>
        </div>
      </main>
    </div>
  );
}
