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

// Workload phases that can hold GPUs, and how to decide whether a workload in that phase really does.
// Observed live: after DELETE a workload goes Deleting; its pod keeps the GPU for a few seconds
// (runningPods > 0), then the pod is gone, yet `allocatedResources` lingers ~30 s and the telemetry
// metrics ~60 s. So for Deleting/Stopping the GPU is held only while pods still run.
export const GPU_PHASES = {
  Running: 'always',
  Initializing: 'allocated', // scheduled, pulling the image
  Creating: 'allocated',
  Resuming: 'allocated',
  Updating: 'allocated',
  Deleting: 'pods',
  Stopping: 'pods',
};

export function holdsGpus(w, rule) {
  const g = Number(w?.allocatedResources?.gpu);
  if (!(g > 0)) return 0;
  if (rule === 'pods') return Number(w.runningPods) > 0 ? g : 0;
  return g;
}

// GPUs held by workloads, per cluster, from the control plane's own workload state (fresh within
// seconds; the telemetry metrics are scraped on an interval and lag in both directions).
export function allocatedFromWorkloads(listsByPhase) {
  const m = new Map();
  const seen = new Set();
  for (const [phase, list] of Object.entries(listsByPhase)) {
    for (const w of list || []) {
      const id = w.id || w.workloadId;
      if (id && seen.has(id)) continue;
      const g = holdsGpus(w, GPU_PHASES[phase]);
      if (id) seen.add(id);
      if (g > 0) m.set(w.clusterId, (m.get(w.clusterId) || 0) + g);
    }
  }
  return m;
}

export const USAGE_SOURCES = ['workloads', 'max', 'telemetry'];

// `projects`: pass an already-fetched list (or null if unavailable) to skip re-reading it; they change
// rarely, so the caller caches them while capacity is re-read every few seconds.
// `usageSource`: 'workloads' (default) = GPUs held by workloads, telemetry only if workloads are
// unavailable; 'max' = the larger of both (never under-reports, but lags when workloads end);
// 'telemetry' = the metrics only.
export async function collectSnapshot(client, { now = () => Date.now(), projects: given, usageSource = 'workloads' } = {}) {
  const errors = [];
  const needTelemetryUsage = usageSource !== 'workloads';
  const wl = (phase) => settle(`${phase.toLowerCase()} workloads`, () => client.list('/api/v1/workloads', 'workloads', { filterBy: [`phase==${phase}`] }, { max: 2000 }), errors);
  const tel = (type, label) => settle(`telemetry ${label}`, () => client.get('/api/v1/nodes/telemetry', { telemetryType: type, groupBy: ['ClusterId'] }), errors);
  const phases = Object.keys(GPU_PHASES);

  const [clusters, tTotal0, tAlloc0, tFree0, projects, pending, ...phaseLists] = await Promise.all([
    client.get('/api/v1/clusters'),
    tel(TELEMETRY.total, 'TOTAL_GPUS'),
    needTelemetryUsage ? tel(TELEMETRY.allocated, 'ALLOCATED_GPUS') : null,
    needTelemetryUsage ? tel(TELEMETRY.free, 'FREE_GPUS') : null,
    given !== undefined ? given : settle('projects', () => client.list('/api/v1/org-unit/projects', 'projects'), errors),
    wl('Pending'),
    ...phases.map((ph) => wl(ph)),
  ]);
  const byPhase = Object.fromEntries(phases.map((ph, i) => [ph, phaseLists[i]]));
  const running = byPhase.Running;
  const workloadsOk = running !== null; // without the Running list we cannot say what is in use

  // Telemetry usage is only fetched when asked for, or as the fallback when workloads are unavailable.
  let tAlloc = tAlloc0; let tFree = tFree0;
  if (!workloadsOk && !needTelemetryUsage) {
    [tAlloc, tFree] = await Promise.all([tel(TELEMETRY.allocated, 'ALLOCATED_GPUS'), tel(TELEMETRY.free, 'FREE_GPUS')]);
  }
  const total = parseTelemetryByCluster(tTotal0);
  const telFree = parseTelemetryByCluster(tFree);
  const telAlloc = parseTelemetryByCluster(tAlloc);
  const wlAlloc = workloadsOk ? allocatedFromWorkloads(byPhase) : null;

  const countBy = (list) => {
    const m = new Map();
    for (const w of list || []) m.set(w.clusterId, (m.get(w.clusterId) || 0) + 1);
    return m;
  };
  const pendingBy = pending ? countBy(pending) : null;
  const runningBy = running ? countBy(running) : null;
  // Workloads Run:ai has accounted for: they hold GPUs (counted above) or are queued as Pending. A workload
  // that is listed but is still starting, with no GPUs allocated yet, is NOT accounted for, so its
  // reservation must keep covering it (otherwise its GPUs look free for the seconds it takes to start).
  const accountedWorkloadIds = new Set();
  for (const w of pending || []) { const id = w.id || w.workloadId; if (id) accountedWorkloadIds.add(id); }
  for (const ph of phases) for (const w of byPhase[ph] || []) { const id = w.id || w.workloadId; if (id && holdsGpus(w, GPU_PHASES[ph]) > 0) accountedWorkloadIds.add(id); }

  const projectsByCluster = new Map();
  for (const p of projects || []) {
    if (!projectsByCluster.has(p.clusterId)) projectsByCluster.set(p.clusterId, new Map());
    projectsByCluster.get(p.clusterId).set(p.name, { id: p.id, name: p.name, ...summarizeProjectQuota(p) });
  }

  const snapshots = (clusters || []).map((c) => {
    const t = total.get(c.uuid);
    const ta = telAlloc.get(c.uuid);
    const tf = telFree.get(c.uuid);
    const wa = wlAlloc ? wlAlloc.get(c.uuid) || 0 : undefined;
    const state = c.status?.state;

    let allocated = null;
    let used = 'none';
    if (usageSource === 'telemetry') { allocated = ta ?? wa ?? null; used = ta !== undefined ? 'telemetry' : 'workloads'; }
    else if (usageSource === 'max') { const k = [ta, wa].filter((x) => x !== undefined); allocated = k.length ? Math.max(...k) : null; used = 'max'; }
    else if (wa !== undefined) { allocated = wa; used = 'workloads'; }
    else if (ta !== undefined) { allocated = ta; used = 'telemetry'; }

    let free = null;
    if (t !== undefined && allocated !== null) free = Math.max(0, t - allocated);
    else if (tf !== undefined) free = tf; // only the telemetry free figure is available

    return {
      id: c.uuid,
      name: c.name,
      version: c.version || null,
      state: state || 'Unknown',
      connected: state === 'Connected',
      lastLiveness: c.lastLiveness || null,
      gpu: {
        total: t ?? null,
        free,
        allocated,
        // where the numbers came from, for transparency
        source: { used, telemetryAllocated: ta ?? null, workloadsAllocated: wa ?? null, telemetryFree: tf ?? null },
      },
      pending: pendingBy ? pendingBy.get(c.uuid) || 0 : null,
      running: runningBy ? runningBy.get(c.uuid) || 0 : null,
      projects: projects ? Object.fromEntries(projectsByCluster.get(c.uuid) || []) : null,
    };
  });

  return { collectedAt: now(), clusters: snapshots, errors, accountedWorkloadIds, projectsList: projects || null };
}
