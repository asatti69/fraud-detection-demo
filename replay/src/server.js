// Replay server: plays data/replay.csv through the Java scoring API at a steady rate and
// broadcasts every result to dashboards over WebSocket.
//
//   HTTP  GET  /health   replay server + API status (used by start.sh)
//         GET  /state    full snapshot (same as the WebSocket hello message)
//         GET  /metrics  held-out test metrics, proxied from the Java API
//         POST /control  {"action": "start" | "pause" | "resume" | "restart" | "rate", "rate": 3}
//   WS    /ws            server -> client: hello, reset, scored, status, config
//                        client -> server: {"type": "control", "action": ..., "rate": ...}
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocketServer } from 'ws';
import { buildSequence, loadReplay } from './replay-data.js';
import { addToTotals, emptyTotals, outcome } from './totals.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
export const RATE_LIMITS = { min: 2, max: 5 };
const RECENT_LIMIT = 100;
const RETRY_MS = 1000;

const REPLAY_NOTE =
  'The replay holds every fraud case from the held-out test set (75) plus 2,000 randomly sampled ' +
  'normal test transactions, so fraud is about 3.6% of the replay versus 0.13% in real traffic. ' +
  'Running totals describe this replay only; held-out test results come from /metrics.';

export function createReplayServer(options = {}) {
  const cfg = {
    apiUrl: 'http://localhost:8080',
    port: 8081,
    rate: 3,
    mode: 'demo',
    demoAtSeconds: 20,
    loop: true,
    startOnConnect: true,
    apiTimeoutMs: 2000,
    csvPath: path.join(ROOT, 'data', 'replay.csv'),
    quiet: false,
    ...options,
  };
  cfg.rate = clampRate(cfg.rate);
  const rows = loadReplay(cfg.csvPath);

  let model = null; // { threshold, modelVersion } from the API's /health
  let plan = null; // { sequence, demoFraud, demoPosition }
  let state = 'waiting'; // waiting | connecting_api | running | paused | api_unavailable | finished
  let started = false;
  let stopped = false;
  let position = 0;
  let totals = emptyTotals();
  let recent = [];
  let seq = 0;
  let runId = 0;
  let startedAt = null;
  let nextDueAt = 0;
  let loopPromise = null;

  const server = http.createServer(handleHttp);
  const wss = new WebSocketServer({ server, path: '/ws' });

  wss.on('connection', (socket) => {
    socket.send(JSON.stringify(snapshot('hello')));
    socket.on('message', (data) => {
      let msg;
      try {
        msg = JSON.parse(data.toString());
      } catch {
        return socket.send(JSON.stringify({ type: 'error', error: 'Messages must be JSON' }));
      }
      if (msg.type === 'control') {
        const result = control(msg);
        if (!result.ok) socket.send(JSON.stringify({ type: 'error', error: result.error }));
      }
    });
    if (!started && cfg.startOnConnect) control({ action: 'start' });
  });

  function log(event, fields = {}) {
    if (!cfg.quiet) console.log(JSON.stringify({ '@timestamp': new Date().toISOString(), service: 'fraud-replay', event, ...fields }));
  }

  function broadcast(msg) {
    const data = JSON.stringify(msg);
    for (const client of wss.clients) {
      if (client.readyState === client.OPEN) client.send(data);
    }
  }

  function setState(next, extra = {}) {
    if (state === next) return;
    state = next;
    log('state_changed', { state, ...extra });
    broadcast({ type: 'status', state, ...extra });
  }

  function snapshot(type) {
    return {
      type,
      state,
      config: { mode: cfg.mode, rate: cfg.rate, rateLimits: RATE_LIMITS, demoAtSeconds: cfg.demoAtSeconds, loop: cfg.loop },
      model,
      demoFraud: plan?.demoFraud
        ? {
            replayRow: plan.demoFraud.replayRow,
            amount: plan.demoFraud.amount,
            position: plan.demoPosition,
            playsAtSeconds: plan.demoPosition / cfg.rate,
          }
        : null,
      replay: { transactions: rows.length, fraud: rows.filter((r) => r.label === 1).length, note: REPLAY_NOTE },
      position,
      totals,
      recent,
    };
  }

  // Starts (or restarts) the replay from the first transaction with fresh totals.
  function resetRun(reason) {
    runId++;
    position = 0;
    totals = emptyTotals();
    recent = [];
    seq = 0;
    startedAt = Date.now();
    nextDueAt = startedAt;
    if (model) plan = buildSequence(rows, { mode: cfg.mode, rate: cfg.rate, threshold: model.threshold, demoAtSeconds: cfg.demoAtSeconds });
    setState(model ? 'running' : 'connecting_api');
    log('run_started', { reason, mode: cfg.mode, rate: cfg.rate, demoFraudReplayRow: plan?.demoFraud?.replayRow ?? null });
    broadcast({ ...snapshot('reset'), reason });
  }

  function control({ action, rate }) {
    switch (action) {
      case 'start':
        if (started) return { ok: true, state };
        started = true;
        resetRun('start');
        return { ok: true, state };
      case 'restart':
        started = true;
        resetRun('restart');
        return { ok: true, state };
      case 'pause':
        if (state === 'running' || state === 'api_unavailable') setState('paused');
        return { ok: true, state };
      case 'resume':
        if (state === 'paused') {
          nextDueAt = Date.now();
          setState('running');
        }
        return { ok: true, state };
      case 'rate': {
        if (typeof rate !== 'number' || !Number.isFinite(rate)) return { ok: false, error: 'rate must be a number' };
        cfg.rate = clampRate(rate);
        log('rate_changed', { rate: cfg.rate });
        broadcast({ type: 'config', config: snapshot('config').config });
        return { ok: true, state, rate: cfg.rate };
      }
      default:
        return { ok: false, error: `Unknown action: ${action}` };
    }
  }

  async function fetchModel() {
    const res = await fetch(`${cfg.apiUrl}/health`, { signal: AbortSignal.timeout(cfg.apiTimeoutMs) });
    if (!res.ok) throw new Error(`API /health returned ${res.status}`);
    const health = await res.json();
    return { threshold: health.threshold, modelVersion: health.modelVersion };
  }

  async function scoreRow(row) {
    const res = await fetch(`${cfg.apiUrl}/score`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: `replay-${row.replayRow}`, ...row.features }),
      signal: AbortSignal.timeout(cfg.apiTimeoutMs),
    });
    if (!res.ok) throw new Error(`API /score returned ${res.status}`);
    return res.json();
  }

  async function connectToApi() {
    while (!model && !stopped) {
      try {
        model = await fetchModel();
        log('api_connected', { apiUrl: cfg.apiUrl, ...model });
        if (started) resetRun('api_connected');
      } catch (e) {
        setState('api_unavailable', { error: e.message });
        await sleep(RETRY_MS);
      }
    }
  }

  async function playLoop() {
    await connectToApi();
    while (!stopped) {
      if (!started || !plan || state === 'paused' || state === 'finished') {
        await sleep(50);
        continue;
      }
      if (position >= plan.sequence.length) {
        if (cfg.loop) resetRun('replay_finished_looping');
        else setState('finished');
        continue;
      }
      const wait = nextDueAt - Date.now();
      if (wait > 0) {
        await sleep(Math.min(wait, 50)); // short sleeps so pause/restart take effect quickly
        continue;
      }

      const row = plan.sequence[position];
      const run = runId;
      const t0 = performance.now();
      let result;
      try {
        result = await scoreRow(row);
      } catch (e) {
        if (run === runId && state !== 'paused') {
          // Keep the same transaction and retry; the stream resumes where it stopped.
          setState('api_unavailable', { error: e.message });
          nextDueAt = Date.now() + RETRY_MS;
        }
        continue;
      }
      if (run !== runId || stopped) continue; // restarted while this request was in flight
      if (state === 'api_unavailable') setState('running');

      const event = {
        seq: ++seq,
        replayRow: row.replayRow,
        id: result.id,
        time: row.time,
        amount: row.amount,
        score: result.score,
        threshold: result.threshold,
        flagged: result.flagged,
        label: row.label,
        outcome: outcome(result.flagged, row.label),
        scripted: row === plan.demoFraud,
        apiLatencyMs: result.latencyMs,
        roundTripMs: performance.now() - t0,
        modelVersion: result.modelVersion,
        elapsedSeconds: (Date.now() - startedAt) / 1000,
      };
      totals = addToTotals(totals, event);
      recent = [...recent.slice(-(RECENT_LIMIT - 1)), event];
      position++;
      broadcast({ type: 'scored', event, totals, position });
      if (event.flagged || event.scripted) {
        log('transaction_flagged', { seq: event.seq, replayRow: event.replayRow, amount: event.amount, score: event.score, outcome: event.outcome, scripted: event.scripted, elapsedSeconds: event.elapsedSeconds });
      }

      // Steady cadence: schedule from the previous due time, but never try to "catch up" in a burst.
      nextDueAt += 1000 / cfg.rate;
      if (nextDueAt < Date.now() - 1000 / cfg.rate) nextDueAt = Date.now();
    }
  }

  async function handleHttp(req, res) {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    const url = new URL(req.url, 'http://localhost');
    try {
      if (req.method === 'OPTIONS') return send(res, 204);
      if (req.method === 'GET' && url.pathname === '/health') {
        return send(res, 200, {
          status: 'UP',
          state,
          mode: cfg.mode,
          rate: cfg.rate,
          api: { url: cfg.apiUrl, connected: model !== null && state !== 'api_unavailable', modelVersion: model?.modelVersion ?? null },
        });
      }
      if (req.method === 'GET' && url.pathname === '/state') return send(res, 200, snapshot('hello'));
      if (req.method === 'GET' && url.pathname === '/metrics') {
        const upstream = await fetch(`${cfg.apiUrl}/metrics`, { signal: AbortSignal.timeout(cfg.apiTimeoutMs) });
        res.writeHead(upstream.status, { 'Content-Type': 'application/json' });
        return res.end(await upstream.text());
      }
      if (req.method === 'POST' && url.pathname === '/control') {
        const result = control(JSON.parse((await readBody(req)) || '{}'));
        return send(res, result.ok ? 200 : 400, result);
      }
      return send(res, 404, { error: 'Not found' });
    } catch (e) {
      return send(res, e instanceof SyntaxError ? 400 : 502, { error: e.message });
    }
  }

  return {
    async start() {
      await new Promise((resolve) => server.listen(cfg.port, resolve));
      loopPromise = playLoop();
      const port = server.address().port;
      log('replay_server_started', { port, apiUrl: cfg.apiUrl, mode: cfg.mode, rate: cfg.rate, transactions: rows.length });
      return port;
    },
    async stop() {
      stopped = true;
      for (const client of wss.clients) client.terminate();
      await new Promise((resolve) => wss.close(() => server.close(resolve)));
      await loopPromise;
    },
    control,
  };
}

function clampRate(rate) {
  return Math.min(RATE_LIMITS.max, Math.max(RATE_LIMITS.min, Number(rate)));
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function send(res, status, body) {
  if (body === undefined) {
    res.writeHead(status);
    return res.end();
  }
  res.writeHead(status, { 'Content-Type': 'application/json' });
  return res.end(JSON.stringify(body));
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', (chunk) => (body += chunk));
    req.on('end', () => resolve(body));
    req.on('error', reject);
  });
}

// Run directly: node src/server.js [--mode=demo|replay] [--rate=3]
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const args = Object.fromEntries(
    process.argv.slice(2).map((a) => a.replace(/^--/, '').split('=')).map(([k, v]) => [k, v ?? 'true']),
  );
  const replay = createReplayServer({
    apiUrl: process.env.API_URL ?? 'http://localhost:8080',
    port: Number(process.env.PORT ?? 8081),
    rate: Number(args.rate ?? process.env.RATE ?? 3),
    mode: args.mode ?? process.env.MODE ?? 'demo',
  });
  await replay.start();
  for (const signal of ['SIGINT', 'SIGTERM']) {
    process.on(signal, async () => {
      await replay.stop();
      process.exit(0);
    });
  }
}
