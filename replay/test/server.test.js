// Runs the replay server against a stand-in scoring API that can be switched off,
// to prove the stream, controls, and recovery work without the Java service.
import assert from 'node:assert/strict';
import http from 'node:http';
import { after, before, test } from 'node:test';
import WebSocket from 'ws';
import { createReplayServer } from '../src/server.js';

const THRESHOLD = 6.745466810943141;
let fakeApiDown = false;
let fakeFlagAll = false;
let fakeApi;
let replay;
let base;

before(async () => {
  fakeApi = http.createServer((req, res) => {
    if (fakeApiDown) {
      res.writeHead(503);
      return res.end();
    }
    if (req.url === '/health') return json(res, { status: 'UP', threshold: THRESHOLD, modelVersion: 'fake-model' });
    if (req.url === '/metrics') return json(res, { test: { tp: 31 } });
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      const tx = JSON.parse(body);
      const score = fakeFlagAll || tx.Amount === 127.14 ? 10 : 1; // the demo fraud scores high, everything else low
      json(res, { id: tx.id, score, threshold: THRESHOLD, flagged: score >= THRESHOLD, modelVersion: 'fake-model', latencyMs: 0.05 });
    });
  });
  await new Promise((r) => fakeApi.listen(0, r));
  replay = createReplayServer({ apiUrl: `http://localhost:${fakeApi.address().port}`, port: 0, rate: 5, quiet: true });
  base = `localhost:${await replay.start()}`;
  while (!(await getJson('/health')).api.connected) await sleep(20); // model info loaded before any dashboard connects
});

after(async () => {
  await replay.stop();
  await new Promise((r) => fakeApi.close(r));
});

test('a dashboard gets a hello snapshot, then a live stream of scored transactions', async () => {
  const client = await connect();
  const hello = await client.next((m) => m.type === 'hello');
  assert.deepEqual(hello.model, { threshold: THRESHOLD, modelVersion: 'fake-model' });
  assert.equal(hello.replay.transactions, 2075);
  assert.ok(hello.replay.note.includes('3.6%'));

  const reset = await client.next((m) => m.type === 'reset');
  assert.deepEqual(reset.demoFraud, { replayRow: 1293, amount: 127.14, position: 100, playsAtSeconds: 20 });

  const events = [];
  while (events.length < 5) events.push((await client.next((m) => m.type === 'scored')).event);
  assert.deepEqual(events.map((e) => e.seq), [1, 2, 3, 4, 5]);
  assert.deepEqual(events.map((e) => e.replayRow), [0, 1, 2, 3, 4]);
  assert.ok(events.every((e) => e.outcome === 'TN' && e.modelVersion === 'fake-model'));
  const gap = events[4].elapsedSeconds - events[0].elapsedSeconds;
  assert.ok(gap > 0.6 && gap < 1.2, `5 tx/s should space 4 gaps ~0.8s apart, got ${gap}`);
  client.close();
});

test('if the API goes down the stream pauses on the same transaction and resumes without skipping', async () => {
  const client = await connect();
  const last = (await client.next((m) => m.type === 'scored')).event;
  fakeApiDown = true;
  const down = await client.next((m) => m.type === 'status' && m.state === 'api_unavailable');
  assert.match(down.error, /503/);
  fakeApiDown = false;
  await client.next((m) => m.type === 'status' && m.state === 'running', 5000);
  const next = (await client.next((m) => m.type === 'scored' && m.event.seq > last.seq)).event;
  assert.equal(next.seq, last.seq + 1);
  assert.equal(next.replayRow, last.replayRow + 1);
  client.close();
});

test('pause, resume and restart controls', async () => {
  const client = await connect();
  client.send({ type: 'control', action: 'pause' });
  await client.next((m) => m.type === 'status' && m.state === 'paused');
  await sleep(150); // let any request already in flight land
  const pausedAt = (await getJson('/state')).position;
  await sleep(700);
  assert.equal((await getJson('/state')).position, pausedAt, 'no transactions while paused');

  client.send({ type: 'control', action: 'resume' });
  await client.next((m) => m.type === 'scored');

  client.send({ type: 'control', action: 'restart' });
  const reset = await client.next((m) => m.type === 'reset');
  assert.equal(reset.totals.scored, 0);
  const first = await client.next((m) => m.type === 'scored');
  assert.equal(first.event.seq, 1);
  assert.equal(first.event.replayRow, 0);
  client.close();
});

test('rate is limited to 2-5 transactions per second', async () => {
  assert.equal(replay.control({ action: 'rate', rate: 50 }).rate, 5);
  assert.equal(replay.control({ action: 'rate', rate: 0.1 }).rate, 2);
  assert.equal(replay.control({ action: 'rate', rate: 5 }).rate, 5);
  assert.equal(replay.control({ action: 'bogus' }).ok, false);
});

test('HTTP health and metrics proxy', async () => {
  const health = await getJson('/health');
  assert.equal(health.status, 'UP');
  assert.equal(health.api.connected, true);
  assert.equal(health.api.modelVersion, 'fake-model');
  assert.deepEqual(await getJson('/metrics'), { test: { tp: 31 } });
});

test('snapshots carry the last 5 alerts, so a refreshed dashboard rebuilds its alerts panel', async () => {
  const client = await connect();
  fakeFlagAll = true;
  client.send({ type: 'control', action: 'restart' });
  await client.next((m) => m.type === 'reset');
  let last;
  for (let i = 0; i < 7; i++) last = (await client.next((m) => m.type === 'scored')).event;
  fakeFlagAll = false;
  client.close();

  const refreshed = await connect(); // a page refresh is a new connection
  const hello = await refreshed.next((m) => m.type === 'hello');
  assert.equal(hello.recentAlerts.length, 5);
  assert.ok(hello.recentAlerts.every((e) => e.flagged));
  assert.equal(hello.recentAlerts.at(-1).seq >= last.seq, true);
  refreshed.send({ type: 'control', action: 'restart' });
  const reset = await refreshed.next((m) => m.type === 'reset');
  assert.deepEqual(reset.recentAlerts, []);
  refreshed.close();
});

function json(res, body) {
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(body));
}

async function getJson(p) {
  return (await fetch(`http://${base}${p}`)).json();
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

/** WebSocket client with a "wait for the next message matching X" helper. */
async function connect() {
  const ws = new WebSocket(`ws://${base}/ws`);
  const queue = [];
  const waiters = [];
  ws.on('message', (data) => {
    const msg = JSON.parse(data.toString());
    const i = waiters.findIndex((w) => w.match(msg));
    if (i >= 0) waiters.splice(i, 1)[0].resolve(msg);
    else queue.push(msg);
  });
  await new Promise((resolve, reject) => ws.once('open', resolve).once('error', reject));
  return {
    next(match, timeoutMs = 3000) {
      const i = queue.findIndex(match);
      if (i >= 0) return Promise.resolve(queue.splice(i, 1)[0]);
      return new Promise((resolve, reject) => {
        const waiter = { match, resolve };
        waiters.push(waiter);
        setTimeout(() => {
          const j = waiters.indexOf(waiter);
          if (j >= 0) {
            waiters.splice(j, 1);
            reject(new Error('Timed out waiting for message'));
          }
        }, timeoutMs);
      });
    },
    send: (msg) => ws.send(JSON.stringify(msg)),
    close: () => ws.close(),
  };
}
