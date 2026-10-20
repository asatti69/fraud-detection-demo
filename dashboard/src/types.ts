// Shapes of artifacts/metrics.json (served by GET /metrics) and the replay server's WebSocket messages.

export interface ThresholdResult {
  threshold: number;
  recall: number | null;
  precision: number | null;
  alert_rate: number;
  alerts: number;
  tp: number;
  fp: number;
  fn: number;
  tn: number;
  fraud_dollars_caught: number;
  fraud_dollars_total: number;
  fraud_dollars_caught_pct: number | null;
  n_transactions: number;
}

export interface Metrics {
  threshold: number;
  threshold_rule: string;
  test: ThresholdResult;
  test_threshold_free: { roc_auc: number; average_precision: number; fraud_base_rate: number };
  threshold_sweep: { target_validation_alert_rate: number; test: ThresholdResult }[];
}

export type Outcome = 'TP' | 'FP' | 'FN' | 'TN';

export interface ScoredEvent {
  seq: number;
  replayRow: number;
  id: string;
  time: number;
  amount: number;
  score: number;
  threshold: number;
  flagged: boolean;
  label: 0 | 1;
  outcome: Outcome;
  scripted: boolean;
  apiLatencyMs: number;
  roundTripMs: number;
  modelVersion: string;
  elapsedSeconds: number;
}

export interface Totals {
  scored: number;
  flagged: number;
  tp: number;
  fp: number;
  fn: number;
  tn: number;
  amountScored: number;
  fraudDollarsSeen: number;
  fraudDollarsCaught: number;
}

export type ServerState = 'waiting' | 'connecting_api' | 'running' | 'paused' | 'api_unavailable' | 'finished';

export interface StreamConfig {
  mode: 'demo' | 'replay';
  rate: number;
  rateLimits: { min: number; max: number };
  demoAtSeconds: number;
  loop: boolean;
}

export interface Snapshot {
  type: 'hello' | 'reset';
  state: ServerState;
  config: StreamConfig;
  model: { threshold: number; modelVersion: string } | null;
  demoFraud: { replayRow: number; amount: number; position: number; playsAtSeconds: number } | null;
  replay: { transactions: number; fraud: number; note: string };
  position: number;
  totals: Totals;
  recent: ScoredEvent[];
  /** Last 5 alerts, kept by the server even after their events leave `recent`. */
  recentAlerts: ScoredEvent[];
}

export type ServerMessage =
  | Snapshot
  | { type: 'scored'; event: ScoredEvent; totals: Totals; position: number }
  | { type: 'status'; state: ServerState; error?: string }
  | { type: 'config'; config: StreamConfig }
  | { type: 'error'; error: string };
