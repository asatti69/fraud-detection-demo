// Dashboard state for the replay stream, driven by WebSocket messages.
import type { ScoredEvent, ServerMessage, ServerState, Snapshot, StreamConfig, Totals } from './types.ts';

export const MAX_EVENTS = 120;
/** Alerts are kept separately (and sent in every snapshot) so they stay on screen until newer alerts replace them. */
export const MAX_ALERTS = 5;

export type Connection = 'connecting' | 'open' | 'closed';

export interface StreamState {
  connection: Connection;
  serverState: ServerState | null;
  error: string | null;
  config: StreamConfig | null;
  model: Snapshot['model'];
  demoFraud: Snapshot['demoFraud'];
  replay: Snapshot['replay'] | null;
  totals: Totals | null;
  events: ScoredEvent[];
  alerts: ScoredEvent[];
}

export type StreamAction = { type: 'connection'; connection: Connection } | { type: 'message'; message: ServerMessage };

export const initialStreamState: StreamState = {
  connection: 'connecting',
  serverState: null,
  error: null,
  config: null,
  model: null,
  demoFraud: null,
  replay: null,
  totals: null,
  events: [],
  alerts: [],
};

export function streamReducer(state: StreamState, action: StreamAction): StreamState {
  if (action.type === 'connection') return { ...state, connection: action.connection };

  const msg = action.message;
  switch (msg.type) {
    case 'hello':
    case 'reset':
      // A snapshot replaces everything, so a refreshed or late-joining dashboard catches up.
      return {
        ...state,
        serverState: msg.state,
        error: null,
        config: msg.config,
        model: msg.model,
        demoFraud: msg.demoFraud,
        replay: msg.replay,
        totals: msg.totals,
        events: msg.recent.slice(-MAX_EVENTS),
        alerts: msg.recentAlerts.slice(-MAX_ALERTS),
      };
    case 'scored':
      if (state.events.at(-1)?.seq === msg.event.seq) return state;
      return {
        ...state,
        totals: msg.totals,
        events: [...state.events, msg.event].slice(-MAX_EVENTS),
        alerts: msg.event.flagged ? [...state.alerts, msg.event].slice(-MAX_ALERTS) : state.alerts,
      };
    case 'status':
      return { ...state, serverState: msg.state, error: msg.error ?? null };
    case 'config':
      return { ...state, config: msg.config };
    default:
      return state;
  }
}
