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
  assert.deepEqual(west.gpu, { total: 32, free: 12, allocated: 20, ready: 32 });
  assert.equal(west.connected, true);
  assert.deepEqual(Object.keys(west.projects).sort(), ['demo-team', 'research']);
  const off = snap.clusters.find((c) => c.name === 'offline-lab');
  assert.equal(off.connected, false);
  assert.equal(off.state, 'Disconnected');
});

test('pending/running counts come from workloads', async () => {
  const mock = createMockRunai();
  mock.state.workloads.push(
    { workloadId: '1', clusterId: 'c-osmo', actualPhase: 'Pending' },
    { workloadId: '2', clusterId: 'c-osmo', actualPhase: 'Pending' },
    { workloadId: '3', clusterId: 'c-west', actualPhase: 'Running' },
  );
  const snap = await collectSnapshot(mk(mock));
  assert.equal(snap.clusters.find((c) => c.id === 'c-osmo').pending, 2);
  assert.equal(snap.clusters.find((c) => c.id === 'c-west').running, 1);
  assert.equal(snap.clusters.find((c) => c.id === 'c-west').pending, 0);
});

test('missing telemetry becomes null (never invented) and is reported', async () => {
  const mock = createMockRunai();
  const failing = (u, i) => (u.toString().includes('telemetryType=FREE_GPUS') || u.toString().includes('telemetryType=ALLOCATED_GPUS')
    ? Promise.resolve(new Response('{"message":"telemetry down"}', { status: 500 })) : mock.fetch(u, i));
  const snap = await collectSnapshot(mk(mock, failing));
  const west = snap.clusters.find((c) => c.name === 'cluster-a');
  assert.equal(west.gpu.total, 32);
  assert.equal(west.gpu.free, null);
  assert.equal(west.gpu.allocated, null);
  assert.ok(snap.errors.some((e) => /FREE_GPUS/.test(e)));
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
