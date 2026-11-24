// Projects usable on any cluster: with AUTO_CREATE_PROJECTS a cluster that lacks the chosen
// project gets a matching one created on demand. Without it, behavior is unchanged.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { readFileSync } from 'node:fs';
import { rankClusters } from '../server/placement.js';
import { buildProjectPayload } from '../server/payloads.js';
import { RunaiClient } from '../server/runai-client.js';
import { createMockRunai } from '../server/mock-runai.js';
import { ClusterManager } from '../server/service.js';
import { createApp } from '../server/server.js';

const contract = JSON.parse(readFileSync(new URL('../contract/workload-contract.json', import.meta.url), 'utf8')).projectCreate;

// ---- placement ----
const cl = (id, free, projects) => ({ id, name: id, state: 'Connected', connected: true, pending: 0, gpu: { total: 32, free, allocated: 32 - free, ready: 32 }, projects });
const has = { llm: { id: 'p1', name: 'llm', deserved: 8, limit: null } };
const req = { gpus: 2, project: 'llm' };

test('without auto-create a cluster lacking the project is ineligible (unchanged behavior)', () => {
  const r = rankClusters([cl('west', 5, has), cl('osmo', 30, {})], req, {});
  assert.equal(r.chosen, 'west');
  assert.match(r.ranked.find((x) => x.clusterId === 'osmo').rejections[0], /does not exist/);
});

test('with auto-create it is eligible and flagged; the most open cluster still wins', () => {
  const r = rankClusters([cl('west', 5, has), cl('osmo', 30, {})], req, { autoCreateProjects: true });
  assert.equal(r.chosen, 'osmo');
  const osmo = r.ranked.find((x) => x.clusterId === 'osmo');
  assert.equal(osmo.eligible, true);
  assert.equal(osmo.createsProject, true);
  assert.match(osmo.reasons.join(' '), /will be created on this cluster/);
  assert.match(r.message, /will be created there/);
  assert.equal(r.ranked.find((x) => x.clusterId === 'west').createsProject, false);
});

test('with auto-create, the cluster that already has the project is not penalised when it is more open', () => {
  const r = rankClusters([cl('west', 30, has), cl('osmo', 5, {})], req, { autoCreateProjects: true });
  assert.equal(r.chosen, 'west');
  assert.equal(r.message.includes('will be created'), false);
});

test('a disconnected cluster is still never chosen, even with auto-create', () => {
  const off = { ...cl('off', 32, {}), connected: false, state: 'Disconnected' };
  assert.equal(rankClusters([off, cl('west', 1, has)], req, { autoCreateProjects: true }).chosen, 'west');
});

// ---- project payload vs the Run:ai API contract ----
test('project payload uses only fields defined by the API and the required ones', () => {
  for (const overQuota of [true, false]) {
    const b = buildProjectPayload({ name: 'llm-training1', clusterId: 'c1', nodePoolId: 100000, nodePoolName: 'default', overQuota });
    for (const k of Object.keys(b)) assert.ok(contract.topKeys.includes(k), `unknown project field ${k}`);
    for (const k of contract.topRequired) assert.notEqual(b[k], undefined, `missing ${k}`);
    for (const r of b.resources) {
      for (const k of Object.keys(r)) assert.ok(contract.resourceKeys.includes(k), k);
      for (const k of Object.keys(r.gpu)) assert.ok(contract.gpuKeys.includes(k), k);
      for (const k of Object.keys(r.nodePool)) assert.ok(contract.nodePoolKeys.includes(k), k);
      for (const k of contract.nodePoolRequired) assert.notEqual(r.nodePool[k], undefined, k);
      assert.equal(typeof r.nodePool.id, 'string');
    }
    assert.equal(b.resources[0].gpu.deserved, 0);
    assert.equal('overQuotaWeight' in b.resources[0].gpu, overQuota);
  }
});

test('project payload rejects names the API would not accept', () => {
  assert.throws(() => buildProjectPayload({ name: 'Bad Name', clusterId: 'c', nodePoolId: 1 }), /cannot create a project/);
});

// ---- end to end ----
const open = new Set();
after(() => { for (const s of open) { s.close(); s.closeAllConnections(); } });

async function start({ autoCreate = true, overQuotaOff = [] } = {}) {
  const mock = createMockRunai({
    clusters: [
      { uuid: 'c-west', name: 'cluster-a', state: 'Connected', total: 32, allocated: 0 },
      { uuid: 'c-osmo', name: 'cluster-b', state: 'Connected', total: 2, allocated: 1 },
    ],
    projectsByCluster: { 'c-west': ['llm-training1', 'team-a'], 'c-osmo': [] },
    overQuotaOff,
  });
  const config = { mock: true, controlPlane: 'mock', uiUser: '', uiPassword: '', capacityTtlMs: 0, reservationTtlMs: 60000, policy: { excludeClusters: [], allowUnknownCapacity: false, noFitStrategy: 'queue', autoCreateProjects: autoCreate } };
  const client = new RunaiClient({ baseUrl: 'http://mock', ...mock.credentials, fetchImpl: mock.fetch, retries: 0, retryDelayMs: 1 });
  const manager = new ClusterManager({ client, config });
  const server = createApp({ manager, config });
  open.add(server);
  server.listen(0);
  await once(server, 'listening');
  const base = `http://127.0.0.1:${server.address().port}`;
  const call = async (method, path, body) => {
    const res = await fetch(base + path, { method, headers: { 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
    return { status: res.status, json: await res.json() };
  };
  return { mock, call, manager };
}
const wl = (over = {}) => ({ type: 'training', name: 'job', project: 'llm-training1', image: 'busybox:1.36', gpus: 1, ...over });

test('projects list is the union across clusters and says where it would be created', async () => {
  const t = await start();
  const { json } = await t.call('GET', '/api/projects');
  assert.deepEqual(json.map((p) => p.name), ['llm-training1', 'team-a']);
  assert.deepEqual(json[0].clusters, ['cluster-a']);
  assert.deepEqual(json[0].missingOn, ['cluster-b']);
});

test('placing on a cluster without the project creates it, then runs the workload there', async () => {
  const t = await start();
  assert.equal(t.mock.state.projects.some((p) => p.clusterId === 'c-osmo'), false);
  const r = await t.call('POST', '/api/workloads', wl({ pinnedClusterId: 'c-osmo' }));
  assert.equal(r.status, 202, JSON.stringify(r.json));
  assert.equal(r.json.placement.chosenName, 'cluster-b');
  assert.equal(r.json.workload.actualPhase, 'Running');
  assert.equal(t.mock.state.projectCreates, 1);
  const created = t.mock.state.projects.find((p) => p.clusterId === 'c-osmo' && p.name === 'llm-training1');
  assert.ok(created);
  assert.equal(t.mock.state.workloads.at(-1).projectName, 'llm-training1');
});

test('the created project is reused by later submissions (created once)', async () => {
  const t = await start();
  await t.call('POST', '/api/workloads', wl({ name: 'a', pinnedClusterId: 'c-osmo', gpus: 0 }));
  await t.call('POST', '/api/workloads', wl({ name: 'b', pinnedClusterId: 'c-osmo', gpus: 0 }));
  assert.equal(t.mock.state.projectCreates, 1);
});

test('automatic placement can pick the cluster that lacks the project when it is the most open', async () => {
  const t = await start();
  t.mock.state.clusters[0].allocated = 31; // west: 1 free
  t.mock.state.clusters[1].allocated = 0; // osmo: 2 free
  const r = await t.call('POST', '/api/workloads', wl({ gpus: 2 }));
  assert.equal(r.status, 202);
  assert.equal(r.json.placement.chosenName, 'cluster-b');
  assert.equal(t.mock.state.projectCreates, 1);
});

test('dry-run placement reports the pending creation without creating anything', async () => {
  const t = await start();
  const { json } = await t.call('POST', '/api/placement', wl({ gpus: 1 }));
  assert.equal(json.ranked.find((r) => r.name === 'cluster-b').createsProject, true);
  assert.equal(t.mock.state.projectCreates || 0, 0);
});

test('clusters with over-quota off: creation is retried without the weight', async () => {
  const t = await start({ overQuotaOff: ['c-osmo'] });
  const r = await t.call('POST', '/api/workloads', wl({ pinnedClusterId: 'c-osmo', gpus: 0 }));
  assert.equal(r.status, 202, JSON.stringify(r.json));
  assert.equal(t.mock.state.calls.filter((c) => c === 'POST /api/v1/org-unit/projects').length, 2);
  assert.equal(t.mock.state.projectCreates, 1);
});

test('a project created by someone else after our snapshot (409) is picked up, not an error', async () => {
  const t = await start();
  await t.call('GET', '/api/clusters'); // warm the snapshot cache (no project on osmo yet)
  t.mock.state.projects.push({ id: 'p-external', name: 'llm-training1', clusterId: 'c-osmo', status: { phase: 'Ready' }, resources: [] });
  const r = await t.call('POST', '/api/workloads', wl({ pinnedClusterId: 'c-osmo', gpus: 0 }));
  assert.equal(r.status, 202, JSON.stringify(r.json));
  assert.equal(t.mock.state.projectCreates || 0, 0);
});

test('project creation failure is reported and no workload is created', async () => {
  const t = await start();
  t.mock.state.failProjectCreate = { 'c-osmo': 403 };
  const r = await t.call('POST', '/api/workloads', wl({ pinnedClusterId: 'c-osmo' }));
  assert.equal(r.status, 403);
  assert.match(r.json.error, /Could not create project "llm-training1" on cluster-b/);
  assert.equal(t.mock.state.workloads.length, 0);
  assert.deepEqual(t.manager.reservations.snapshot(), {});
});

test('without AUTO_CREATE_PROJECTS the old rule holds: 409, nothing created', async () => {
  const t = await start({ autoCreate: false });
  const r = await t.call('POST', '/api/workloads', wl({ pinnedClusterId: 'c-osmo' }));
  assert.equal(r.status, 409);
  assert.equal(t.mock.state.projectCreates || 0, 0);
  const projects = (await t.call('GET', '/api/projects')).json;
  assert.deepEqual(projects[0].missingOn, []);
});
