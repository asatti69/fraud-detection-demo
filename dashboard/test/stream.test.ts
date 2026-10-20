import assert from 'node:assert/strict';
import { test } from 'node:test';
import { initialStreamState, MAX_EVENTS, streamReducer } from '../src/stream.ts';
import type { ScoredEvent, Snapshot, Totals } from '../src/types.ts';

const totals = (scored: number): Totals => ({
  scored, flagged: 0, tp: 0, fp: 0, fn: 0, tn: scored, amountScored: 0, fraudDollarsSeen: 0, fraudDollarsCaught: 0,
});

const event = (seq: number): ScoredEvent => ({
  seq, replayRow: seq - 1, id: `replay-${seq - 1}`, time: 0, amount: 10, score: 0.5, threshold: 6.75, flagged: false,
  label: 0, outcome: 'TN', scripted: false, apiLatencyMs: 0.1, roundTripMs: 1, modelVersion: 'v', elapsedSeconds: seq / 3,
});

const snapshot = (type: 'hello' | 'reset', recent: ScoredEvent[], recentAlerts: ScoredEvent[] = []): Snapshot => ({
  type, state: 'running', config: { mode: 'demo', rate: 3, rateLimits: { min: 2, max: 5 }, demoAtSeconds: 20, loop: true },
  model: { threshold: 6.75, modelVersion: 'v' }, demoFraud: null,
  replay: { transactions: 2075, fraud: 75, note: 'note' }, position: recent.length, totals: totals(recent.length), recent, recentAlerts,
});

test('hello loads the snapshot so a refreshed dashboard catches up', () => {
  const s = streamReducer(initialStreamState, { type: 'message', message: snapshot('hello', [event(1), event(2)]) });
  assert.equal(s.events.length, 2);
  assert.equal(s.totals?.scored, 2);
  assert.equal(s.serverState, 'running');
});

test('scored events append, keep at most MAX_EVENTS, and ignore duplicates', () => {
  let s = initialStreamState;
  for (let i = 1; i <= MAX_EVENTS + 5; i++) {
    s = streamReducer(s, { type: 'message', message: { type: 'scored', event: event(i), totals: totals(i), position: i } });
  }
  assert.equal(s.events.length, MAX_EVENTS);
  assert.equal(s.events.at(-1)?.seq, MAX_EVENTS + 5);
  const again = streamReducer(s, { type: 'message', message: { type: 'scored', event: event(MAX_EVENTS + 5), totals: totals(1), position: 1 } });
  assert.equal(again, s);
});

test('reset clears the feed and totals', () => {
  let s = streamReducer(initialStreamState, { type: 'message', message: snapshot('hello', [event(1)]) });
  s = streamReducer(s, { type: 'message', message: snapshot('reset', []) });
  assert.equal(s.events.length, 0);
  assert.equal(s.totals?.scored, 0);
});

test('status messages carry API outages', () => {
  const s = streamReducer(initialStreamState, { type: 'message', message: { type: 'status', state: 'api_unavailable', error: 'fetch failed' } });
  assert.equal(s.serverState, 'api_unavailable');
  assert.equal(s.error, 'fetch failed');
});

test('recent alerts stay until newer alerts replace them, even after the feed buffer rolls over', () => {
  let s = initialStreamState;
  for (let i = 1; i <= 300; i++) {
    const e = { ...event(i), flagged: i % 50 === 0 || i <= 7, outcome: 'FP' as const };
    s = streamReducer(s, { type: 'message', message: { type: 'scored', event: e, totals: totals(i), position: i } });
  }
  assert.deepEqual(s.alerts.map((e) => e.seq), [100, 150, 200, 250, 300]);
  s = streamReducer(s, { type: 'message', message: snapshot('reset', []) });
  assert.equal(s.alerts.length, 0);
});

test('a refresh rebuilds recent alerts from the snapshot, even when they are older than the feed buffer', () => {
  const oldAlerts = [10, 20, 30, 40, 50].map((seq) => ({ ...event(seq), flagged: true, outcome: 'TP' as const }));
  const recentFeed = [event(400), event(401)]; // no alerts among the latest events
  const s = streamReducer(initialStreamState, { type: 'message', message: snapshot('hello', recentFeed, oldAlerts) });
  assert.deepEqual(s.alerts.map((e) => e.seq), [10, 20, 30, 40, 50]);
  assert.equal(s.events.length, 2);
});
