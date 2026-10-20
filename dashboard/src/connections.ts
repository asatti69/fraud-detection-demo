// The dashboard talks only to the replay server: WebSocket for the live stream,
// HTTP for /metrics (which the replay server passes through from the Java API).
import { useCallback, useEffect, useReducer, useRef, useState } from 'react';
import { initialStreamState, streamReducer } from './stream.ts';
import type { Metrics } from './types.ts';

const REPLAY_URL: string = import.meta.env.VITE_REPLAY_URL ?? `http://${window.location.hostname || 'localhost'}:8081`;
const RETRY_MS = 1000;

export type ControlAction = 'pause' | 'resume' | 'restart';

/** Live stream with automatic reconnect, so a replay-server restart heals on its own. */
export function useReplayStream() {
  const [state, dispatch] = useReducer(streamReducer, initialStreamState);
  const socket = useRef<WebSocket | null>(null);

  useEffect(() => {
    let disposed = false;
    let retryTimer: number | undefined;
    const connect = () => {
      dispatch({ type: 'connection', connection: 'connecting' });
      const ws = new WebSocket(`${REPLAY_URL.replace(/^http/, 'ws')}/ws`);
      socket.current = ws;
      ws.onopen = () => dispatch({ type: 'connection', connection: 'open' });
      ws.onmessage = (e) => dispatch({ type: 'message', message: JSON.parse(e.data) });
      ws.onclose = () => {
        if (disposed) return;
        dispatch({ type: 'connection', connection: 'closed' });
        retryTimer = window.setTimeout(connect, RETRY_MS);
      };
    };
    connect();
    return () => {
      disposed = true;
      window.clearTimeout(retryTimer);
      socket.current?.close();
    };
  }, []);

  const control = useCallback((action: ControlAction) => {
    if (socket.current?.readyState === WebSocket.OPEN) socket.current.send(JSON.stringify({ type: 'control', action }));
  }, []);

  return { stream: state, control };
}

/** artifacts/metrics.json via GET /metrics, retried until it loads. */
export function useMetrics() {
  const [metrics, setMetrics] = useState<Metrics | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let disposed = false;
    let retryTimer: number | undefined;
    const load = async () => {
      try {
        const res = await fetch(`${REPLAY_URL}/metrics`);
        if (!res.ok) throw new Error(`GET /metrics returned ${res.status}`);
        const body: Metrics = await res.json();
        if (!disposed) {
          setMetrics(body);
          setError(null);
        }
      } catch (e) {
        if (disposed) return;
        setError(e instanceof Error ? e.message : String(e));
        retryTimer = window.setTimeout(load, RETRY_MS * 2);
      }
    };
    load();
    return () => {
      disposed = true;
      window.clearTimeout(retryTimer);
    };
  }, []);

  return { metrics, error };
}
