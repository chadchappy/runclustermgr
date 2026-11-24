// Placement engine: pure functions, no I/O.
//
// Hard constraints (a cluster failing any is ineligible):
//   - not excluded by policy
//   - connected to the control plane
//   - the requested project exists on that cluster
//   - request does not exceed the project's GPU limit on that cluster
// Among eligible clusters the order is lexicographic and fully explainable:
//   1. fits right now (known free GPUs >= requested)
//   2. most free GPUs (after subtracting recent in-flight reservations)
//   3. fewest pending workloads
//   4. lowest GPU allocation ratio
//   5. name (deterministic tie-break)
// If nothing fits now and policy.noFitStrategy === 'queue', the best eligible
// cluster by (fewest pending, most free) is chosen and the result is flagged
// `queued: true`; with 'reject' no cluster is chosen.

const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null);

export function rankClusters(snapshots, request, policy = {}, reservations = {}) {
  const need = Math.max(0, Number(request.gpus) || 0);
  const exclude = new Set(policy.excludeClusters || []);
  const evaluated = snapshots.map((c) => {
    const reasons = [];
    const rejections = [];
    const reserved = reservations[c.id] || 0;
    const rawFree = num(c.gpu?.free);
    const free = rawFree === null ? null : Math.max(0, rawFree - reserved);
    const total = num(c.gpu?.total);

    if (exclude.has(c.id) || exclude.has(c.name)) rejections.push('excluded by policy');
    if (!c.connected) rejections.push(`cluster is not connected (state: ${c.state})`);
    let project = null;
    let createsProject = false;
    if (c.projects) {
      project = c.projects[request.project] || null;
      if (!project) {
        if (policy.autoCreateProjects) createsProject = true;
        else rejections.push(`project "${request.project}" does not exist on this cluster`);
      }
    }
    if (project && project.limit !== null && project.limit !== undefined && need > project.limit) {
      rejections.push(`request of ${need} GPU exceeds project GPU limit of ${project.limit}`);
    }
    if (request.pinnedClusterId && request.pinnedClusterId !== c.id) rejections.push('a different cluster was pinned');

    const eligible = rejections.length === 0;
    let fitsNow = false;
    if (eligible) {
      if (need === 0) fitsNow = true;
      else if (free === null) {
        reasons.push('GPU availability unknown');
        if (policy.allowUnknownCapacity) fitsNow = true;
      }
      else if (free >= need) fitsNow = true;
      else reasons.push(`only ${fmt(free)} GPU free, ${fmt(need)} needed`);
    }
    if (eligible && fitsNow && need > 0) {
      reasons.unshift(`${fmt(free)} of ${total ?? '?'} GPU free${reserved ? ` (${fmt(reserved)} reserved for in-flight submissions)` : ''}`);
      if (project && project.deserved >= need) reasons.push(`within project's guaranteed quota (${project.deserved})`);
      if (createsProject) reasons.push(`project "${request.project}" will be created on this cluster`);
      if (c.pending === 0) reasons.push('no pending workloads');
      else if (c.pending > 0) reasons.push(`${c.pending} workload(s) pending`);
    }
    const allocRatio = total ? (num(c.gpu?.allocated) ?? (free === null ? 1 : total - free)) / total : 1;
    const score = eligible && total ? Math.max(0, Math.min(100, Math.round(((free ?? 0) - need) / total * 100))) : 0;

    return { clusterId: c.id, name: c.name, eligible, fitsNow, createsProject, free, reserved, total, pending: c.pending ?? null, allocRatio, score, reasons, rejections };
  });

  const byFit = (a, b) =>
    (b.fitsNow - a.fitsNow) ||
    ((b.free ?? -1) - (a.free ?? -1)) ||
    ((a.pending ?? Infinity) - (b.pending ?? Infinity)) ||
    (a.allocRatio - b.allocRatio) ||
    a.name.localeCompare(b.name);
  const byQueue = (a, b) =>
    ((a.pending ?? Infinity) - (b.pending ?? Infinity)) ||
    ((b.free ?? -1) - (a.free ?? -1)) ||
    a.name.localeCompare(b.name);

  const eligible = evaluated.filter((e) => e.eligible);
  const ineligible = evaluated.filter((e) => !e.eligible);
  const fitting = eligible.filter((e) => e.fitsNow).sort(byFit);
  const nonFitting = eligible.filter((e) => !e.fitsNow).sort(byQueue);

  let chosen = null;
  let queued = false;
  let message;
  if (fitting.length) {
    chosen = fitting[0];
    message = `Placing on ${chosen.name}: ${chosen.reasons[0] || 'available'}${chosen.createsProject ? ` (project "${request.project}" will be created there)` : ''}`;
  } else if (nonFitting.length && (policy.noFitStrategy || 'queue') === 'queue') {
    chosen = nonFitting[0];
    queued = true;
    message = `No cluster has ${fmt(need)} GPU free right now; queueing on ${chosen.name} (${chosen.pending ?? '?'} pending)`;
  } else if (nonFitting.length) {
    message = `No cluster has ${fmt(need)} GPU free and queueing is disabled`;
  } else {
    message = 'No eligible cluster: ' + (ineligible.map((e) => `${e.name}: ${e.rejections.join('; ')}`).join(' | ') || 'no clusters found');
  }

  return { chosen: chosen ? chosen.clusterId : null, queued, message, ranked: [...fitting, ...nonFitting, ...ineligible] };
}

function fmt(n) {
  return Number.isInteger(n) ? String(n) : String(Math.round(n * 100) / 100);
}

// In-flight reservations: after we submit, Run:ai telemetry lags by seconds.
// Without this, a burst of submissions would all land on the same cluster.
export class Reservations {
  constructor(ttlMs = 90000, now = () => Date.now()) {
    this.ttlMs = ttlMs;
    this.now = now;
    this.items = []; // {clusterId, gpus, at}
  }
  add(clusterId, gpus) {
    if (gpus > 0) this.items.push({ clusterId, gpus, at: this.now() });
  }
  release(clusterId, gpus) {
    const i = this.items.findIndex((x) => x.clusterId === clusterId && x.gpus === gpus);
    if (i >= 0) this.items.splice(i, 1);
  }
  snapshot() {
    const cutoff = this.now() - this.ttlMs;
    this.items = this.items.filter((x) => x.at > cutoff);
    const out = {};
    for (const x of this.items) out[x.clusterId] = (out[x.clusterId] || 0) + x.gpus;
    return out;
  }
}
