import type { ControlAction } from '../connections.ts';
import type { StreamState } from '../stream.ts';

type Tone = 'good' | 'warning' | 'critical';

function status(stream: StreamState): { tone: Tone; icon: string; label: string } {
  if (stream.connection !== 'open') return { tone: 'warning', icon: '◌', label: 'Connecting to replay server…' };
  switch (stream.serverState) {
    case 'running':
      return { tone: 'good', icon: '●', label: 'Live' };
    case 'paused':
      return { tone: 'warning', icon: '❚❚', label: 'Paused' };
    case 'api_unavailable':
      return { tone: 'critical', icon: '▲', label: 'Scoring API unavailable, retrying' };
    case 'finished':
      return { tone: 'warning', icon: '■', label: 'Replay finished' };
    default:
      return { tone: 'warning', icon: '◌', label: 'Connecting to scoring API…' };
  }
}

export function Header({ stream, onControl }: { stream: StreamState; onControl: (a: ControlAction) => void }) {
  const s = status(stream);
  const paused = stream.serverState === 'paused';
  const canControl = stream.connection === 'open';
  return (
    <header className="header">
      <div>
        <h1>Card fraud detection: live scoring</h1>
        <p className="subtitle">
          Autoencoder trained in PyTorch, exported to ONNX, scored by a Java API
          {stream.model && <> · model {stream.model.modelVersion}</>}
        </p>
      </div>
      <div className="header-controls">
        <span className={`status-pill tone-${s.tone}`} role="status">
          <span aria-hidden="true">{s.icon}</span> {s.label}
        </span>
        <button type="button" disabled={!canControl} onClick={() => onControl(paused ? 'resume' : 'pause')}>
          {paused ? 'Resume' : 'Pause'}
        </button>
        <button type="button" disabled={!canControl} onClick={() => onControl('restart')}>
          Restart
        </button>
      </div>
    </header>
  );
}
