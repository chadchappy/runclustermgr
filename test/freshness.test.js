// Real-time behaviour: faster refresh, fresher usage figures, no double counting of reservations.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { loadConfig } from '../server/config.js';
import { Reservations } from '../server/placement.js';
import { RunaiClient } from '../server/runai-client.js';
import { createMockRunai } from '../server/mock-runai.js';
import { ClusterManager } from '../server/service.js';
import { createApp } from '../server/server.js';

const open = new Set();
after(() => { for (const s of open) { s.close(); s.closeAllConnections(); } });

async function start({ ttl = 0, clock } = {}) {
  const mock = createMockRunai({ clusters: [{ uuid: 'c-a', name: 'a', state: 'Connected', total: 32, allocated: 0 }], projects: ['p'] });
  const config = { mock: true, controlPlane: 'mock', uiUser: '', uiPassword: '', capacityTtlMs: ttl, reservationTtlMs: 600000, policy: { excludeClusters: [], allowUnknownCapacity: false, noFitStrategy: 'queue', autoCreateProjects: false } };
  const client = new RunaiClient({ baseUrl: 'http://mock', ...mock.credentials, fetchImpl: mock.fetch, retries: 0, retryDelayMs: 1 });
  const manager = new ClusterManager({ client, config, ...(clock ? { now: clock } : {}) });
  const server = createApp({ manager, config });
  open.add(server);
  server.listen(0);
  await once(server, 'listening');
  const base = `http://127.0.0.1:${server.address().port}`;
  const call = async (method, path, body) => {
    const res = await fetch(base + path, { method, headers: { 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
    return { status: res.status, json: await res.json() };
  };
  return { mock, manager, call };
}
const wl = (over = {}) => ({ type: 'training', name: 'job', project: 'p', image: 'busybox:1.36', gpus: 4, ...over });
const free = async (t) => (await t.call('GET', '/api/clusters?refresh=1')).json.clusters[0].gpu.free;

test('default capacity cache is short (4 s) so the portal reflects usage quickly', () => {
  assert.equal(loadConfig({ MOCK: '1' }).capacityTtlMs, 4000);
  assert.equal(loadConfig({ MOCK: '1', CAPACITY_TTL_MS: '1000' }).capacityTtlMs, 1000);
});

test('a submitted workload is counted ONCE: no double counting from the reservation once Run:ai lists it', async () => {
  const t = await start();
  assert.equal(await free(t), 32);
  const r = await t.call('POST', '/api/workloads', wl({ gpus: 4 }));
  assert.equal(r.status, 202);
  // The mock has allocated 4 and lists the workload as Running: 28 free, NOT 24 (28 minus a stale reservation).
  assert.equal(await free(t), 28);
  assert.deepEqual(t.manager.reservations.snapshot(), {}, 'reservation settled once the workload was visible');
});

test('while Run:ai cannot see the workload yet, the reservation holds the GPUs; it settles when the workload appears', async () => {
  const t = await start();
  t.mock.state.hideWorkloadList = true; // control-plane lag
  await t.call('POST', '/api/workloads', wl({ gpus: 4 }));
  t.mock.state.clusters[0].allocated = 0; // telemetry has not caught up either
  assert.equal(await free(t), 28, 'reserved 4 of 32 while nothing else shows it');
  t.mock.state.hideWorkloadList = false; // the list catches up
  t.mock.state.clusters[0].allocated = 4;
  assert.equal(await free(t), 28, 'now counted by Run:ai; reservation dropped, not added on top');
  assert.deepEqual(t.manager.reservations.snapshot(), {});
});

test('Reservations: attach links the workload id, settle only drops matching ones, expiry still works', () => {
  let now = 0;
  const r = new Reservations(1000, () => now);
  r.add('c', 2);
  r.add('c', 2);
  r.attach('c', 2, 'w-1'); // attaches to the most recent un-linked one
  r.settle(new Set(['w-1']));
  assert.deepEqual(r.snapshot(), { c: 2 });
  r.settle(new Set(['other']));
  assert.deepEqual(r.snapshot(), { c: 2 });
  r.settle(new Set());
  assert.deepEqual(r.snapshot(), { c: 2 });
  now = 2000;
  assert.deepEqual(r.snapshot(), {}, 'unlinked reservations still expire');
});

test('projects are read once per minute, not on every refresh', async () => {
  let t0 = 0;
  const t = await start({ ttl: 0, clock: () => t0 });
  const projectCalls = () => t.mock.state.calls.filter((c) => c.includes('/org-unit/projects')).length;
  await t.call('GET', '/api/clusters?refresh=1');
  const first = projectCalls();
  assert.ok(first >= 1);
  for (let i = 0; i < 5; i++) { t0 += 5000; await t.call('GET', '/api/clusters?refresh=1'); }
  assert.equal(projectCalls(), first, 'five refreshes over 25 s did not re-read projects');
  t0 += 40000; // past 60 s
  await t.call('GET', '/api/clusters?refresh=1');
  assert.equal(projectCalls(), first + 1);
});

test('the workload list is cached for 3 s so several browsers polling cost one Run:ai call', async () => {
  let t0 = 0;
  const t = await start({ ttl: 0, clock: () => t0 });
  const listCalls = () => t.mock.state.calls.filter((c) => c.startsWith('GET /api/v1/workloads?') && c.includes('sortBy=createdAt')).length;
  await Promise.all([t.call('GET', '/api/workloads'), t.call('GET', '/api/workloads'), t.call('GET', '/api/workloads')]);
  assert.equal(listCalls(), 1);
  t0 += 4000;
  await t.call('GET', '/api/workloads');
  assert.equal(listCalls(), 2);
});

test('creating a project invalidates the project cache so the new project is usable at once', async () => {
  const mock = createMockRunai({ clusters: [{ uuid: 'c-a', name: 'a', state: 'Connected', total: 8, allocated: 0 }, { uuid: 'c-b', name: 'b', state: 'Connected', total: 8, allocated: 0 }], projectsByCluster: { 'c-a': ['p'], 'c-b': [] } });
  const config = { mock: true, capacityTtlMs: 0, reservationTtlMs: 60000, policy: { excludeClusters: [], noFitStrategy: 'queue', autoCreateProjects: true } };
  const client = new RunaiClient({ baseUrl: 'http://mock', ...mock.credentials, fetchImpl: mock.fetch, retries: 0, retryDelayMs: 1 });
  const m = new ClusterManager({ client, config });
  await m.clusters({ maxAgeMs: 0 });
  assert.ok(m.projectsCache);
  await m.submit(wl({ pinnedClusterId: 'c-b', gpus: 0 }));
  const after = (await m.clusters({ maxAgeMs: 0 })).clusters.find((c) => c.id === 'c-b');
  assert.ok(after.projects.p, 'project created on demand is visible on the next read');
});

test('USAGE_SOURCE is read from the environment (default workloads; unknown values fall back)', () => {
  assert.equal(loadConfig({ MOCK: '1' }).usageSource, 'workloads');
  assert.equal(loadConfig({ MOCK: '1', USAGE_SOURCE: 'max' }).usageSource, 'max');
  assert.equal(loadConfig({ MOCK: '1', USAGE_SOURCE: 'telemetry' }).usageSource, 'telemetry');
  assert.equal(loadConfig({ MOCK: '1', USAGE_SOURCE: 'bogus' }).usageSource, 'workloads');
});

test('snapshot(maxAgeMs: 0) always re-reads, even within the same millisecond', async () => {
  const t0 = 1000;
  const t = await start({ ttl: 0, clock: () => t0 }); // frozen clock: every call "happens" at the same instant
  const calls = () => t.mock.state.calls.filter((c) => c === 'GET /api/v1/clusters').length;
  await t.call('GET', '/api/clusters?refresh=1');
  const a = calls();
  await t.call('GET', '/api/clusters?refresh=1');
  assert.equal(calls(), a + 1);
});

test('a workload that is deleted frees its GPUs as soon as its pods stop (no waiting for metrics to catch up)', async () => {
  const t = await start();
  await t.call('POST', '/api/workloads', wl({ gpus: 4 }));
  t.mock.state.hideBackground = true; // only workload state counts in this test; telemetry is simulated below
  assert.equal(await free(t), 28);
  const w = t.mock.state.workloads[0];
  w.phase = 'Deleting'; w.runningPods = 1; // shutting down, pod still running
  assert.equal(await free(t), 28);
  w.runningPods = 0; // pod gone; the GPU is free even though allocatedResources lingers and telemetry has not moved
  t.mock.state.clusters[0].allocated = 4; // telemetry still says 4 in use, but no workload explains it
  assert.equal(await free(t), 32);
});

test('a workload that is listed but still starting (no GPUs allocated yet) keeps its reservation; it settles once GPUs are allocated', async () => {
  const t = await start();
  t.mock.state.hideBackground = true;
  await t.call('POST', '/api/workloads', wl({ gpus: 4 }));
  const w = t.mock.state.workloads[0];
  // Run:ai lists it, but it is still Creating and nothing is allocated: the GPUs must not look free
  w.phase = 'Creating'; w.allocatedResources = { gpu: 0 }; t.mock.state.clusters[0].allocated = 0;
  assert.equal(await free(t), 28, 'reservation still holds the 4 GPUs while the workload starts');
  assert.deepEqual(t.manager.reservations.snapshot(), { 'c-a': 4 });
  // now scheduled: GPUs allocated and visible
  w.phase = 'Initializing'; w.allocatedResources = { gpu: 4 };
  assert.equal(await free(t), 28, 'counted by the workload, reservation dropped (not 24)');
  assert.deepEqual(t.manager.reservations.snapshot(), {});
});

test('a queued (Pending) workload settles its reservation: it holds no GPUs, so reserving would block capacity needlessly', async () => {
  const t = await start();
  t.mock.state.hideBackground = true;
  await t.call('POST', '/api/workloads', wl({ gpus: 4 }));
  const w = t.mock.state.workloads[0];
  w.phase = 'Pending'; w.allocatedResources = { gpu: 0 }; t.mock.state.clusters[0].allocated = 0;
  assert.equal(await free(t), 32);
  assert.deepEqual(t.manager.reservations.snapshot(), {});
});
