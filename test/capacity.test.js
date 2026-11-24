import { test } from 'node:test';
import assert from 'node:assert/strict';
import { collectSnapshot, parseTelemetryByCluster, summarizeProjectQuota } from '../server/capacity.js';
import { RunaiClient } from '../server/runai-client.js';
import { createMockRunai } from '../server/mock-runai.js';

const mk = (mock, fetchImpl) => new RunaiClient({ baseUrl: 'http://x', ...mock.credentials, fetchImpl: fetchImpl || mock.fetch, retries: 0, retryDelayMs: 1 });

test('parses grouped telemetry', () => {
  const m = parseTelemetryByCluster({ values: [{ value: '12', groups: [{ key: 'ClusterId', value: 'a' }] }, { value: 'NaN', groups: [{ key: 'ClusterId', value: 'b' }] }, { value: '3', groups: [] }] });
  assert.deepEqual([...m], [['a', 12]]);
  assert.equal(parseTelemetryByCluster(null).size, 0);
});

test('project quota summary: limit is unknown/unlimited unless every pool has one', () => {
  assert.deepEqual(summarizeProjectQuota({ resources: [{ gpu: { deserved: 4, limit: 8 } }, { gpu: { deserved: 2, limit: 2 } }] }), { deserved: 6, limit: 10 });
  assert.deepEqual(summarizeProjectQuota({ resources: [{ gpu: { deserved: 4, limit: -1 } }] }), { deserved: 4, limit: null });
  assert.deepEqual(summarizeProjectQuota({ resources: [{ gpu: { deserved: 4, limit: 8 } }, { gpu: { deserved: 1 } }] }), { deserved: 5, limit: null });
  assert.deepEqual(summarizeProjectQuota({}), { deserved: 0, limit: null });
});

test('snapshot reports real numbers per cluster', async () => {
  const mock = createMockRunai();
  const snap = await collectSnapshot(mk(mock));
  assert.deepEqual(snap.errors, []);
  const west = snap.clusters.find((c) => c.name === 'cluster-a');
  assert.equal(west.gpu.total, 32);
  assert.equal(west.gpu.free, 12);
  assert.equal(west.gpu.allocated, 20);
  // default usage source: GPUs held by workloads (the mock lists its 20 GPUs of background load as one);
  // telemetry usage is not even requested
  assert.deepEqual(west.gpu.source, { used: 'workloads', telemetryAllocated: null, workloadsAllocated: 20, telemetryFree: null });
  assert.equal(west.connected, true);
  assert.deepEqual(Object.keys(west.projects).sort(), ['demo-team', 'research']);
  const off = snap.clusters.find((c) => c.name === 'offline-lab');
  assert.equal(off.connected, false);
  assert.equal(off.state, 'Disconnected');
});

test('pending/running counts come from workloads', async () => {
  const mock = createMockRunai();
  mock.state.workloads.push(
    { workloadId: '1', clusterId: 'c-osmo', phase: 'Pending' },
    { workloadId: '2', clusterId: 'c-osmo', phase: 'Pending' },
    { workloadId: '3', clusterId: 'c-west', phase: 'Running' },
  );
  const snap = await collectSnapshot(mk(mock));
  assert.equal(snap.clusters.find((c) => c.id === 'c-osmo').pending, 2);
  assert.equal(snap.clusters.find((c) => c.id === 'c-west').running, 1);
  assert.equal(snap.clusters.find((c) => c.id === 'c-west').pending, 0);
});

test('nothing known about usage -> free is null (never invented) and the failures are reported', async () => {
  const mock = createMockRunai();
  const failing = (u, i) => {
    const x = u.toString();
    return (x.includes('telemetryType=FREE_GPUS') || x.includes('telemetryType=ALLOCATED_GPUS') || x.includes('/api/v1/workloads'))
      ? Promise.resolve(new Response('{"message":"down"}', { status: 500 })) : mock.fetch(u, i);
  };
  const snap = await collectSnapshot(mk(mock, failing));
  const west = snap.clusters.find((c) => c.name === 'cluster-a');
  assert.equal(west.gpu.total, 32);
  assert.equal(west.gpu.free, null);
  assert.equal(west.gpu.allocated, null);
  assert.ok(snap.errors.some((e) => /FREE_GPUS/.test(e)));
  assert.ok(snap.errors.some((e) => /running workloads/.test(e)));
});

test('telemetry down but running workloads known: usage comes from the workloads', async () => {
  const mock = createMockRunai();
  mock.state.clusters[0].allocated = 0;
  mock.state.workloads.push({ id: 'w1', clusterId: 'c-west', phase: 'Running', allocatedResources: { gpu: 7 } });
  const failing = (u, i) => (u.toString().includes('telemetryType=ALLOCATED_GPUS') || u.toString().includes('telemetryType=FREE_GPUS') ? Promise.resolve(new Response('{}', { status: 500 })) : mock.fetch(u, i));
  const west = (await collectSnapshot(mk(mock, failing))).clusters.find((c) => c.name === 'cluster-a');
  assert.equal(west.gpu.allocated, 7);
  assert.equal(west.gpu.free, 25);
});

test('free is derived from total - allocated only when both are known', async () => {
  const mock = createMockRunai();
  const failing = (u, i) => (u.toString().includes('telemetryType=FREE_GPUS') ? Promise.resolve(new Response('{}', { status: 500 })) : mock.fetch(u, i));
  const snap = await collectSnapshot(mk(mock, failing));
  assert.equal(snap.clusters.find((c) => c.name === 'cluster-a').gpu.free, 12);
});

test('project lookup failure -> projects null (placement will not trust it)', async () => {
  const mock = createMockRunai();
  const failing = (u, i) => (u.toString().includes('/org-unit/projects') ? Promise.resolve(new Response('{}', { status: 500 })) : mock.fetch(u, i));
  const snap = await collectSnapshot(mk(mock, failing));
  assert.equal(snap.clusters[0].projects, null);
  assert.ok(snap.errors.some((e) => /projects/.test(e)));
});

test('a cluster-list failure is fatal (nothing to place on)', async () => {
  const mock = createMockRunai();
  const failing = (u, i) => (u.toString().endsWith('/api/v1/clusters') ? Promise.resolve(new Response('{"message":"nope"}', { status: 500 })) : mock.fetch(u, i));
  await assert.rejects(collectSnapshot(mk(mock, failing)), /nope/);
});

// ---- freshness: telemetry lags, the workload list does not ----
test('stale telemetry: GPUs held by running workloads are counted even before telemetry shows them', async () => {
  const mock = createMockRunai(); // telemetry says 20 allocated of 32
  mock.state.clusters[0].allocated = 0; // ...but telemetry has not caught up at all
  mock.state.workloads.push({ id: 'a', clusterId: 'c-west', phase: 'Running', allocatedResources: { gpu: 3 } }, { id: 'b', clusterId: 'c-west', phase: 'Running', allocatedResources: { gpu: 2.5 } });
  const west = (await collectSnapshot(mk(mock))).clusters.find((c) => c.name === 'cluster-a');
  assert.equal(west.gpu.allocated, 5.5);
  assert.equal(west.gpu.free, 26.5);
});

test('usage sources: workloads (default), max and telemetry differ only when telemetry shows usage the workloads do not', async () => {
  const mk2 = (usageSource) => async () => {
    const mock = createMockRunai(); // telemetry: 20 allocated of 32
    mock.state.hideBackground = true; // 16 GPUs of that are NOT Run:ai workloads (e.g. other pods)
    mock.state.workloads.push({ id: 'a', clusterId: 'c-west', phase: 'Running', allocatedResources: { gpu: 4 } });
    return (await collectSnapshot(mk(mock), { usageSource })).clusters.find((c) => c.name === 'cluster-a').gpu;
  };
  const wl = await mk2('workloads')();
  assert.equal(wl.allocated, 4); assert.equal(wl.free, 28); assert.equal(wl.source.used, 'workloads');
  const mx = await mk2('max')();
  assert.equal(mx.allocated, 20); assert.equal(mx.free, 12);
  const te = await mk2('telemetry')();
  assert.equal(te.allocated, 20); assert.equal(te.free, 12);
});

test('workloads that are shutting down hold their GPUs only while pods still run (live lifecycle)', async () => {
  const mock = createMockRunai();
  mock.state.clusters[0].allocated = 0;
  mock.state.workloads.push(
    { id: 'run', clusterId: 'c-west', phase: 'Running', allocatedResources: { gpu: 2 } },
    { id: 'del-pods', clusterId: 'c-west', phase: 'Deleting', runningPods: 1, allocatedResources: { gpu: 3 } }, // pod still running: GPU held
    { id: 'del-gone', clusterId: 'c-west', phase: 'Deleting', runningPods: 0, allocatedResources: { gpu: 4 } }, // pod gone, field lingers: free
    { id: 'stop', clusterId: 'c-west', phase: 'Stopping', runningPods: 0, allocatedResources: { gpu: 5 } },
    { id: 'init', clusterId: 'c-west', phase: 'Initializing', allocatedResources: { gpu: 1 } }, // scheduled, pulling the image: held
    { id: 'done', clusterId: 'c-west', phase: 'Completed', allocatedResources: { gpu: 6 } }, // not a GPU-holding phase
  );
  const west = (await collectSnapshot(mk(mock))).clusters.find((c) => c.name === 'cluster-a');
  assert.equal(west.gpu.allocated, 6); // 2 + 3 + 1
  assert.equal(west.gpu.free, 26);
  assert.equal(west.running, 1);
});

test('free is total minus in-use, not the (inconsistent) FREE_GPUS metric', async () => {
  // live observation: FREE_GPUS 16 + ALLOCATED_GPUS 24 on a 32-GPU cluster, while workloads held 26
  const mock = createMockRunai();
  const odd = (u, i) => {
    const x = u.toString();
    const body = (v) => Promise.resolve(new Response(JSON.stringify({ values: [{ value: String(v), groups: [{ key: 'ClusterId', value: 'c-west' }] }] }), { status: 200 }));
    if (x.includes('telemetryType=FREE_GPUS')) return body(16);
    if (x.includes('telemetryType=ALLOCATED_GPUS')) return body(24);
    if (x.includes('telemetryType=TOTAL_GPUS')) return body(32);
    return mock.fetch(u, i);
  };
  mock.state.workloads.push({ id: 'a', clusterId: 'c-west', phase: 'Running', allocatedResources: { gpu: 26 } });
  const west = (await collectSnapshot(mk(mock, odd))).clusters.find((c) => c.name === 'cluster-a');
  assert.equal(west.gpu.free, 6);
});

test('pending workloads hold no GPUs', async () => {
  const mock = createMockRunai();
  mock.state.clusters[0].allocated = 0;
  mock.state.workloads.push({ id: 'p', clusterId: 'c-west', phase: 'Pending', allocatedResources: { gpu: 0 } });
  const west = (await collectSnapshot(mk(mock))).clusters.find((c) => c.name === 'cluster-a');
  assert.equal(west.gpu.free, 32);
  assert.equal(west.pending, 1);
});

test('already-fetched projects are reused and not re-read', async () => {
  const mock = createMockRunai();
  const first = await collectSnapshot(mk(mock));
  const before = mock.state.calls.filter((c) => c.includes('/org-unit/projects')).length;
  const again = await collectSnapshot(mk(mock), { projects: first.projectsList });
  assert.equal(mock.state.calls.filter((c) => c.includes('/org-unit/projects')).length, before);
  assert.deepEqual(Object.keys(again.clusters[0].projects), Object.keys(first.clusters[0].projects));
});
