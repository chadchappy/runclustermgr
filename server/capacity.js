// Builds a per-cluster capacity snapshot from the Run:ai API.
//
// Design rule: never invent numbers. If the API did not tell us a value it is
// `null` ("unknown") and the placement engine treats it conservatively.

const TELEMETRY = {
  total: 'TOTAL_GPUS',
  free: 'FREE_GPUS',
  allocated: 'ALLOCATED_GPUS',
  ready: 'READY_GPUS',
};

// GET /api/v1/nodes/telemetry?telemetryType=X&groupBy=ClusterId
// -> { type, timestamp, values: [{ value: "12", groups: [{ key: "ClusterId", value: "<uuid>" }] }] }
export function parseTelemetryByCluster(resp) {
  const out = new Map();
  for (const v of resp?.values || []) {
    const g = (v.groups || []).find((x) => x.key === 'ClusterId');
    const n = Number(v.value);
    if (g && Number.isFinite(n)) out.set(g.value, n);
  }
  return out;
}

// Project resources -> the numbers placement needs. The API reports quota per
// node pool: resources[].gpu.{deserved,limit,overQuotaWeight}. A negative or
// missing limit means "unlimited".
export function summarizeProjectQuota(project) {
  let deserved = 0;
  let limit = null; // null = unlimited / unknown
  let sawLimit = false;
  let unlimited = false;
  for (const r of project.resources || []) {
    const gpu = r.gpu || {};
    if (Number.isFinite(gpu.deserved)) deserved += gpu.deserved;
    if (gpu.limit === undefined || gpu.limit === null || gpu.limit < 0) unlimited = true;
    else { sawLimit = true; limit = (limit ?? 0) + gpu.limit; }
  }
  return { deserved, limit: unlimited || !sawLimit ? null : limit };
}

async function settle(label, fn, errors) {
  try {
    return await fn();
  } catch (e) {
    errors.push(`${label}: ${e.message}`);
    return null;
  }
}

export async function collectSnapshot(client, { now = () => Date.now() } = {}) {
  const errors = [];

  const [clusters, tTotal, tFree, tAlloc, tReady, projects, pending, running] = await Promise.all([
    client.get('/api/v1/clusters'),
    settle('telemetry TOTAL_GPUS', () => client.get('/api/v1/nodes/telemetry', { telemetryType: TELEMETRY.total, groupBy: ['ClusterId'] }), errors),
    settle('telemetry FREE_GPUS', () => client.get('/api/v1/nodes/telemetry', { telemetryType: TELEMETRY.free, groupBy: ['ClusterId'] }), errors),
    settle('telemetry ALLOCATED_GPUS', () => client.get('/api/v1/nodes/telemetry', { telemetryType: TELEMETRY.allocated, groupBy: ['ClusterId'] }), errors),
    settle('telemetry READY_GPUS', () => client.get('/api/v1/nodes/telemetry', { telemetryType: TELEMETRY.ready, groupBy: ['ClusterId'] }), errors),
    settle('projects', () => client.list('/api/v1/org-unit/projects', 'projects'), errors),
    settle('pending workloads', () => client.list('/api/v1/workloads', 'workloads', { filterBy: ['phase==Pending'] }, { max: 2000 }), errors),
    settle('running workloads', () => client.list('/api/v1/workloads', 'workloads', { filterBy: ['phase==Running'] }, { max: 2000 }), errors),
  ]);

  const total = parseTelemetryByCluster(tTotal);
  const free = parseTelemetryByCluster(tFree);
  const alloc = parseTelemetryByCluster(tAlloc);
  const ready = parseTelemetryByCluster(tReady);

  const countBy = (list) => {
    const m = new Map();
    for (const w of list || []) m.set(w.clusterId, (m.get(w.clusterId) || 0) + 1);
    return m;
  };
  const pendingBy = pending ? countBy(pending) : null;
  const runningBy = running ? countBy(running) : null;

  const projectsByCluster = new Map();
  for (const p of projects || []) {
    if (!projectsByCluster.has(p.clusterId)) projectsByCluster.set(p.clusterId, new Map());
    projectsByCluster.get(p.clusterId).set(p.name, { id: p.id, name: p.name, ...summarizeProjectQuota(p) });
  }

  const snapshots = (clusters || []).map((c) => {
    const t = total.get(c.uuid);
    const f = free.get(c.uuid);
    const a = alloc.get(c.uuid);
    const state = c.status?.state;
    return {
      id: c.uuid,
      name: c.name,
      version: c.version || null,
      state: state || 'Unknown',
      connected: state === 'Connected',
      lastLiveness: c.lastLiveness || null,
      gpu: {
        total: t ?? null,
        free: f ?? (t !== undefined && a !== undefined ? Math.max(0, t - a) : null),
        allocated: a ?? null,
        ready: ready.get(c.uuid) ?? null,
      },
      pending: pendingBy ? pendingBy.get(c.uuid) || 0 : null,
      running: runningBy ? runningBy.get(c.uuid) || 0 : null,
      projects: projects ? Object.fromEntries(projectsByCluster.get(c.uuid) || []) : null,
    };
  });

  return { collectedAt: now(), clusters: snapshots, errors };
}
