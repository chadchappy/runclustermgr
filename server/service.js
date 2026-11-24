import { collectSnapshot } from './capacity.js';
import { rankClusters, Reservations } from './placement.js';
import { buildPayload, buildProjectPayload, gpuDemand, validateRequest } from './payloads.js';
import { RunaiError } from './runai-client.js';

export class HttpError extends Error {
  constructor(status, message, details) {
    super(message);
    this.status = status;
    this.details = details;
  }
}

export class ClusterManager {
  constructor({ client, config, now = () => Date.now(), log = () => {} }) {
    this.client = client;
    this.config = config;
    this.now = now;
    this.log = log;
    this.reservations = new Reservations(config.reservationTtlMs, now);
    this.cache = null;
    this.inflight = null;
    this.decisions = [];
  }

  async snapshot({ maxAgeMs = this.config.capacityTtlMs } = {}) {
    if (this.cache && this.now() - this.cache.collectedAt <= maxAgeMs) return this.cache;
    if (this.inflight) return this.inflight;
    this.inflight = collectSnapshot(this.client, { now: this.now })
      .then((s) => { this.cache = s; return s; })
      .finally(() => { this.inflight = null; });
    return this.inflight;
  }

  // Cluster view for the UI: snapshot minus in-flight reservations.
  async clusters(opts) {
    const snap = await this.snapshot(opts);
    const reserved = this.reservations.snapshot();
    return {
      collectedAt: snap.collectedAt,
      errors: snap.errors,
      clusters: snap.clusters.map((c) => ({
        ...c,
        reserved: reserved[c.id] || 0,
        gpu: { ...c.gpu, free: c.gpu.free === null ? null : Math.max(0, c.gpu.free - (reserved[c.id] || 0)) },
      })),
    };
  }

  async projects() {
    const snap = await this.snapshot();
    const byName = {};
    for (const c of snap.clusters) {
      for (const name of Object.keys(c.projects || {})) (byName[name] ||= []).push(c.name);
    }
    return Object.entries(byName)
      .map(([name, clusters]) => ({
        name,
        clusters: clusters.sort(),
        // clusters where the project would be created on demand
        missingOn: this.config.policy.autoCreateProjects ? snap.clusters.filter((c) => c.connected && !(c.projects || {})[name]).map((c) => c.name).sort() : [],
      }))
      .sort((a, b) => a.name.localeCompare(b.name));
  }

  _rank(snap, request) {
    return rankClusters(
      snap.clusters,
      { gpus: gpuDemand(request), project: request.project, pinnedClusterId: request.pinnedClusterId || null },
      this.config.policy,
      this.reservations.snapshot(),
    );
  }

  // Dry run: where would this go?
  async place(request) {
    const errors = validateRequest(request);
    if (errors.length) throw new HttpError(400, 'Invalid workload request', errors);
    const snap = await this.snapshot();
    return { demandGpus: gpuDemand(request), collectedAt: snap.collectedAt, ...this._rank(snap, request) };
  }

  async submit(request) {
    const errors = validateRequest(request);
    if (errors.length) throw new HttpError(400, 'Invalid workload request', errors);

    // Decisions are made on fresh data.
    const snap = await this.snapshot({ maxAgeMs: 3000 });
    const demand = gpuDemand(request);
    const decision = this._rank(snap, request);
    if (!decision.chosen) throw new HttpError(409, decision.message, decision.ranked);

    // Candidate order: chosen first, then the remaining eligible clusters.
    const candidates = [decision.chosen, ...decision.ranked.filter((r) => r.eligible && r.clusterId !== decision.chosen).map((r) => r.clusterId)];
    const maxAttempts = request.pinnedClusterId ? 1 : Math.min(2, candidates.length);
    const attempts = [];

    for (let i = 0; i < maxAttempts; i++) {
      const clusterId = candidates[i];
      const cluster = snap.clusters.find((c) => c.id === clusterId);
      let project = cluster.projects?.[request.project];
      if (!project) {
        if (!this.config.policy.autoCreateProjects) throw new HttpError(409, `Project "${request.project}" not found on ${cluster.name}`);
        project = await this._createProject(cluster, request.project);
      }
      const { path, body } = buildPayload(request, { projectId: project.id, clusterId });

      this.reservations.add(clusterId, demand);
      try {
        const created = await this.client.post(path, body);
        this.cache = null; // next read reflects the new workload
        const rec = {
          time: new Date(this.now()).toISOString(),
          name: request.name, type: request.type, project: request.project, gpus: demand,
          clusterId, clusterName: cluster.name,
          queued: decision.queued && i === 0,
          fallbackFrom: attempts.length ? attempts[0].clusterName : null,
          workloadId: created?.workloadId || null,
          message: decision.message,
        };
        this._record(rec);
        this.log({ event: 'workload_submitted', ...rec });
        return { placement: { ...decision, chosen: clusterId, chosenName: cluster.name, attempts }, workload: created };
      } catch (e) {
        this.reservations.release(clusterId, demand);
        attempts.push({ clusterId, clusterName: cluster.name, error: e.message, status: e.status ?? null });
        this.log({ event: 'submit_failed', clusterId, cluster: cluster.name, status: e.status, error: e.message });
        // Only an explicit 503 ("not created, service unavailable") is safe to
        // retry elsewhere. Timeouts / 5xx may have created the workload, and a
        // retry could duplicate it, so those are surfaced to the caller.
        const safeToFallback = e instanceof RunaiError && e.status === 503;
        if (!safeToFallback || i === maxAttempts - 1) {
          const status = e instanceof RunaiError && e.status >= 400 && e.status < 500 ? e.status : 502;
          throw new HttpError(status, `Submission to ${cluster.name} failed: ${e.message}`, { attempts });
        }
      }
    }
    throw new HttpError(502, 'Submission failed', { attempts });
  }

  // Create `name` on `cluster` (opt-in via AUTO_CREATE_PROJECTS). Returns { id, name }.
  async _createProject(cluster, name) {
    const pools = await this.client.list('/api/v1/node-pools', 'nodepools');
    const mine = pools.filter((p) => p.clusterId === cluster.id);
    const pool = mine.find((p) => p.isDefault) || mine[0];
    if (!pool) throw new HttpError(502, `Cannot create project "${name}" on ${cluster.name}: the cluster reports no node pool`);

    let created;
    try {
      try {
        created = await this.client.post('/api/v1/org-unit/projects', buildProjectPayload({ name, clusterId: cluster.id, nodePoolId: pool.id, nodePoolName: pool.name }));
      } catch (e) {
        // Clusters with the over-quota feature off reject the weight; retry without it.
        if (e instanceof RunaiError && e.status === 400 && /over ?quota/i.test(e.message)) {
          created = await this.client.post('/api/v1/org-unit/projects', buildProjectPayload({ name, clusterId: cluster.id, nodePoolId: pool.id, nodePoolName: pool.name, overQuota: false }));
        } else throw e;
      }
    } catch (e) {
      if (e instanceof RunaiError && e.status === 409) {
        // created concurrently (or we raced a stale cache): look it up
        const found = (await this.client.list('/api/v1/org-unit/projects', 'projects')).find((p) => p.clusterId === cluster.id && p.name === name);
        if (found) { this.cache = null; return { id: found.id, name }; }
      }
      const status = e instanceof RunaiError && e.status >= 400 && e.status < 500 ? e.status : 502;
      throw new HttpError(status, `Could not create project "${name}" on ${cluster.name}: ${e.message}`);
    }
    this.cache = null;
    this.log({ event: 'project_created', cluster: cluster.name, project: name, id: created?.id });
    await this._waitProjectReady(cluster.id, name);
    return { id: created.id, name };
  }

  // The project controller needs a moment to create the namespace. Best effort, bounded.
  async _waitProjectReady(clusterId, name, { tries = 15, delayMs = 1500 } = {}) {
    for (let i = 0; i < tries; i++) {
      try {
        const p = (await this.client.list('/api/v1/org-unit/projects', 'projects')).find((x) => x.clusterId === clusterId && x.name === name);
        if (p?.status?.phase === 'Ready') return true;
      } catch { /* keep trying */ }
      await new Promise((r) => setTimeout(r, delayMs));
    }
    return false;
  }

  _record(rec) {
    this.decisions.unshift(rec);
    this.decisions.length = Math.min(this.decisions.length, 50);
  }

  recentDecisions() {
    return this.decisions;
  }

  async workloads(limit = 25) {
    const [list, snap] = await Promise.all([
      this.client.get('/api/v1/workloads', { limit, sortBy: 'createdAt', sortOrder: 'desc' }),
      this.snapshot(),
    ]);
    const names = Object.fromEntries(snap.clusters.map((c) => [c.id, c.name]));
    const items = Array.isArray(list) ? list : list?.workloads || [];
    return items.map((w) => ({
      id: w.id || w.workloadId,
      name: w.name,
      type: w.type || null,
      project: w.projectName || w.project || null,
      clusterId: w.clusterId,
      cluster: names[w.clusterId] || w.clusterId,
      phase: w.phase || w.actualPhase || null,
      gpus: w.allocatedResources?.gpu ?? w.allocatedGPU ?? null,
      createdAt: w.createdAt || null,
    }));
  }
}
