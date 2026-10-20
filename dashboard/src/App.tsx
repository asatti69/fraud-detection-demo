import { Header } from './components/Header.tsx';
import { ImpactPanel } from './components/ImpactPanel.tsx';
import { RecentAlerts } from './components/RecentAlerts.tsx';
import { ScoreChart } from './components/ScoreChart.tsx';
import { StreamCounters, StreamHeader } from './components/StreamCounters.tsx';
import { TransactionFeed } from './components/TransactionFeed.tsx';
import { useMetrics, useReplayStream } from './connections.ts';

export function App() {
  const { stream, control } = useReplayStream();
  const { metrics, error } = useMetrics();
  const threshold = stream.model?.threshold ?? metrics?.threshold ?? null;

  return (
    <div className="app">
      <Header stream={stream} onControl={control} />
      <main className="layout">
        <div className="column">
          <section className="card stream-card" aria-labelledby="stream-heading">
            <StreamHeader stream={stream} />
            <ScoreChart events={stream.events} threshold={threshold} />
            <StreamCounters stream={stream} />
          </section>
          <div className="card">
            <TransactionFeed events={stream.events} />
          </div>
        </div>
        <div className="column">
          <ImpactPanel metrics={metrics} error={error} />
          <div className="card">
            <RecentAlerts alerts={stream.alerts} />
          </div>
        </div>
      </main>
    </div>
  );
}
