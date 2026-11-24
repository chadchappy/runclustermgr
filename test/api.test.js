// End-to-end: real HTTP server + real client/capacity/placement/submission code
// against the in-process mock Run:ai control plane.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { RunaiClient } from '../server/runai-client.js';
import { createMockRunai } from '../server/mock-runai.js';
import { ClusterManager } from '../server/service.js';
import { createApp } from '../server/server.js';

const open = new Set();
after(() => { for (const s of open) { s.close(); s.closeAllConnections(); } });

async function start({ uiUser = '', uiPassword = '', policy = {}, mockOpts } = {}) {
  const mock = createMockRunai(mockOpts);
  const config = { mock: true, controlPlane: 'mock', uiUser, uiPassword, capacityTtlMs: 0, reservationTtlMs: 60000, policy: { excludeClusters: [], allowUnknownCapacity: false, noFitStrategy: 'queue', ...policy } };
  const client = new RunaiClient({ baseUrl: 'http://mock', ...mock.credentials, fetchImpl: mock.fetch, retryDelayMs: 1 });
  const manager = new ClusterManager({ client, config });
  const server = createApp({ manager, config });
  open.add(server);
  server.listen(0);
  await once(server, 'listening');
  const base = `http://127.0.0.1:${server.address().port}`;
  const call = async (method, path, body, headers = {}) => {
    const res = await fetch(base + path, { method, headers: { 'Content-Type': 'application/json', ...headers }, body: body ? JSON.stringify(body) : undefined });
    const text = await res.text();
    let json; try { json = JSON.parse(text); } catch { json = text; }
    return { status: res.status, json, headers: res.headers };
  };
  return { mock, server, call, manager, close: () => new Promise((r) => { server.close(r); server.closeAllConnections(); }) };
}

const wl = (over = {}) => ({ type: 'training', name: 'job', project: 'demo-team', image: 'img:1', gpus: 4, ...over });

test('GET /api/clusters reports real capacity and connection state', async () => {
  const t = await start();
  const { status, json } = await t.call('GET', '/api/clusters');
  assert.equal(status, 200);
  const west = json.clusters.find((c) => c.name === 'cluster-a');
  assert.equal(west.gpu.free, 12);
  assert.equal(json.clusters.find((c) => c.name === 'offline-lab').connected, false);
  await t.close();
});

test('placement dry-run picks the cluster with the most free GPUs and submits nothing', async () => {
  const t = await start();
  const { status, json } = await t.call('POST', '/api/placement', wl({ gpus: 2 }));
  assert.equal(status, 200);
  assert.equal(json.chosen, 'c-west'); // 12 free vs 2 on cluster-b
  assert.equal(t.mock.state.workloads.length, 0);
  assert.equal(json.ranked.at(-1).clusterId, 'c-off'); // ineligible sorted last
  await t.close();
});

test('submit places the workload on the best cluster, with a valid API payload', async () => {
  const t = await start();
  const { status, json } = await t.call('POST', '/api/workloads', wl({ gpus: 4 }));
  assert.equal(status, 202);
  assert.equal(json.placement.chosenName, 'cluster-a');
  assert.equal(json.workload.clusterId, 'c-west');
  assert.equal(json.workload.actualPhase, 'Running');
  assert.equal(t.mock.state.clusters[0].allocated, 24);
  const dec = (await t.call('GET', '/api/decisions')).json;
  assert.equal(dec[0].clusterName, 'cluster-a');
  await t.close();
});

test('as capacity changes, placement moves to the cluster that now has the most free GPUs', async () => {
  const t = await start();
  t.mock.state.clusters[0].allocated = 31; // west nearly full: 1 free
  t.mock.state.clusters[1].allocated = 0; // osmo: 2 free
  const { json } = await t.call('POST', '/api/workloads', wl({ gpus: 1, name: 'small' }));
  assert.equal(json.placement.chosenName, 'cluster-b');
  await t.close();
});

test('a burst of submissions is spread out by in-flight reservations (telemetry lag)', async () => {
  const t = await start({ mockOpts: { clusters: [
    { uuid: 'a', name: 'alpha', state: 'Connected', total: 16, allocated: 8 },
    { uuid: 'b', name: 'beta', state: 'Connected', total: 16, allocated: 8 },
  ] } });
  // Hold the mock's allocation constant to simulate stale telemetry.
  const orig = t.mock.fetch;
  const results = [];
  for (let i = 0; i < 4; i++) {
    const r = await t.call('POST', '/api/workloads', wl({ name: `burst-${i}`, gpus: 4 }));
    results.push(r.json.placement.chosenName);
    t.mock.state.clusters.forEach((c) => { c.allocated = 8; }); // telemetry hasn't caught up
  }
  assert.deepEqual(results.sort(), ['alpha', 'alpha', 'beta', 'beta']);
  void orig;
  await t.close();
});

test('nothing fits: workload is queued on the least-loaded eligible cluster', async () => {
  const t = await start();
  const { status, json } = await t.call('POST', '/api/workloads', wl({ gpus: 64, name: 'huge' }));
  assert.equal(status, 202);
  assert.equal(json.placement.queued, true);
  assert.equal(json.workload.actualPhase, 'Pending');
  await t.close();
});

test('nothing fits and policy=reject -> 409 with ranking details', async () => {
  const t = await start({ policy: { noFitStrategy: 'reject' } });
  const { status, json } = await t.call('POST', '/api/workloads', wl({ gpus: 64 }));
  assert.equal(status, 409);
  assert.match(json.error, /queueing is disabled/);
  assert.ok(Array.isArray(json.details));
  assert.equal(t.mock.state.workloads.length, 0);
  await t.close();
});

test('unknown project -> 409 explaining every cluster', async () => {
  const t = await start();
  const { status, json } = await t.call('POST', '/api/workloads', wl({ project: 'ghost' }));
  assert.equal(status, 409);
  assert.match(json.error, /project "ghost" does not exist/);
  await t.close();
});

test('invalid request -> 400 with field errors, nothing sent to Run:ai', async () => {
  const t = await start();
  const before = t.mock.state.calls.length;
  const { status, json } = await t.call('POST', '/api/workloads', wl({ name: 'Bad Name', gpus: 1.5 }));
  assert.equal(status, 400);
  assert.ok(json.details.length >= 2);
  assert.equal(t.mock.state.calls.length, before);
  await t.close();
});

test('pinning to a cluster is honored', async () => {
  const t = await start();
  const { json } = await t.call('POST', '/api/workloads', wl({ gpus: 1, pinnedClusterId: 'c-osmo' }));
  assert.equal(json.placement.chosenName, 'cluster-b');
  await t.close();
});

test('503 from the chosen cluster falls back to the next eligible cluster', async () => {
  const t = await start();
  t.mock.state.failSubmit['c-west'] = { status: 503, message: 'unavailable', once: true };
  const { status, json } = await t.call('POST', '/api/workloads', wl({ gpus: 2 }));
  assert.equal(status, 202);
  assert.equal(json.placement.chosenName, 'cluster-b');
  assert.equal(json.placement.attempts[0].clusterName, 'cluster-a');
  assert.equal(t.mock.state.workloads.length, 1); // exactly one workload exists
  await t.close();
});

test('500 is NOT retried elsewhere (it may have been created): no duplicates', async () => {
  const t = await start();
  t.mock.state.failSubmit['c-west'] = { status: 500, message: 'internal', once: true };
  const { status, json } = await t.call('POST', '/api/workloads', wl({ gpus: 2 }));
  assert.equal(status, 502);
  assert.match(json.error, /cluster-a/);
  assert.equal(t.mock.state.workloads.length, 0);
  await t.close();
});

test('a 4xx from Run:ai is passed through as the failure reason', async () => {
  const t = await start();
  t.mock.state.failSubmit['c-west'] = { status: 403, message: 'forbidden for project' };
  const { status, json } = await t.call('POST', '/api/workloads', wl({ gpus: 2 }));
  assert.equal(status, 403);
  assert.match(json.error, /forbidden for project/);
  await t.close();
});

test('failed submit releases its reservation (no phantom GPU usage)', async () => {
  const t = await start();
  t.mock.state.failSubmit['c-west'] = { status: 500, once: true };
  await t.call('POST', '/api/workloads', wl({ gpus: 8 }));
  assert.deepEqual(t.manager.reservations.snapshot(), {});
  await t.close();
});

test('all workload types submit successfully against the contract-enforcing mock', async () => {
  const t = await start();
  for (const [i, extra] of [
    { type: 'workspace' }, { type: 'training' }, { type: 'inference', port: 8080 },
    { type: 'distributed', framework: 'PyTorch', workers: 2 }, { type: 'distributed', framework: 'MPI', workers: 1 },
    { gpus: 0.5, type: 'workspace' }, { gpus: 0, type: 'training' },
  ].entries()) {
    const r = await t.call('POST', '/api/workloads', wl({ name: `t-${i}`, gpus: 1, ...extra }));
    assert.equal(r.status, 202, JSON.stringify(r.json));
  }
  await t.close();
});

test('workload listing maps cluster names', async () => {
  const t = await start();
  await t.call('POST', '/api/workloads', wl({ name: 'listed', gpus: 1 }));
  const { json } = await t.call('GET', '/api/workloads');
  assert.equal(json[0].name, 'listed');
  assert.equal(json[0].cluster, 'cluster-a');
  await t.close();
});

test('projects endpoint lists projects with the clusters that have them', async () => {
  const t = await start();
  const { json } = await t.call('GET', '/api/projects');
  assert.deepEqual(json.map((p) => p.name), ['demo-team', 'research']);
  assert.deepEqual(json[0].clusters, ['cluster-a', 'cluster-b', 'offline-lab']);
  await t.close();
});

test('UI basic auth protects everything except /healthz', async () => {
  const t = await start({ uiUser: 'admin', uiPassword: 's3cret' });
  assert.equal((await t.call('GET', '/healthz')).status, 200);
  assert.equal((await t.call('GET', '/api/clusters')).status, 401);
  assert.equal((await t.call('GET', '/')).status, 401);
  assert.match((await t.call('GET', '/')).headers.get('www-authenticate'), /Basic/);
  const bad = 'Basic ' + Buffer.from('admin:wrong').toString('base64');
  assert.equal((await t.call('GET', '/api/clusters', null, { Authorization: bad })).status, 401);
  const good = 'Basic ' + Buffer.from('admin:s3cret').toString('base64');
  assert.equal((await t.call('GET', '/api/clusters', null, { Authorization: good })).status, 200);
  await t.close();
});

test('static UI is served with security headers; path traversal is blocked', async () => {
  const t = await start();
  const home = await t.call('GET', '/');
  assert.equal(home.status, 200);
  assert.match(home.headers.get('content-security-policy'), /default-src 'self'/);
  assert.equal(home.headers.get('x-frame-options'), 'DENY');
  assert.equal((await t.call('GET', '/..%2f..%2fpackage.json')).status, 404);
  assert.equal((await t.call('GET', '/../package.json')).status, 404);
  assert.equal((await t.call('GET', '/nope.js')).status, 404);
  assert.equal((await t.call('POST', '/')).status, 405);
  await t.close();
});

test('malformed JSON and oversized bodies are rejected', async () => {
  const t = await start();
  const r = await fetch(`http://127.0.0.1:${t.server.address().port}/api/workloads`, { method: 'POST', body: '{nope', headers: { 'Content-Type': 'application/json' } });
  assert.equal(r.status, 400);
  const big = await fetch(`http://127.0.0.1:${t.server.address().port}/api/workloads`, { method: 'POST', body: 'x'.repeat(1024 * 1024 + 10) });
  assert.equal(big.status, 413);
  await t.close();
});

test('/readyz reflects whether Run:ai credentials work', async () => {
  const t = await start();
  assert.equal((await t.call('GET', '/readyz')).status, 200);
  t.manager.client.clientSecret = 'wrong';
  t.manager.client.token = null;
  assert.equal((await t.call('GET', '/readyz')).status, 503);
  await t.close();
});

test('control plane down -> clear 502, not a crash', async () => {
  const t = await start();
  t.manager.client.fetch = () => Promise.reject(new Error('ENOTFOUND'));
  t.manager.client.retries = 0;
  t.manager.client.token = null;
  const r = await t.call('GET', '/api/clusters');
  assert.ok(r.status >= 500, `got ${r.status}`);
  assert.ok(r.json.error);
  await t.close();
});

test('config endpoint never leaks credentials', async () => {
  const t = await start({ uiUser: 'u', uiPassword: 'pw' });
  const auth = { Authorization: 'Basic ' + Buffer.from('u:pw').toString('base64') };
  const r = await t.call('GET', '/api/config', null, auth);
  const s = JSON.stringify(r.json);
  assert.ok(!/pw|mock-secret|password|secret/i.test(s), s);
  await t.close();
});
