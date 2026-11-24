// A stateful, in-process fake of the Run:ai control plane API (the endpoints
// this app uses). It is a `fetch` implementation, so the real client, capacity
// and submission code run unchanged against it. Used by tests and `MOCK=1`.
//
// It enforces the generated OpenAPI contract: unknown fields get a 400, exactly
// like the real API, so payload regressions fail here instead of in production.
import { readFileSync } from 'node:fs';
import { parseManifest, detectManifestGpus } from './intake.js';

const contract = JSON.parse(readFileSync(new URL('../contract/workload-contract.json', import.meta.url), 'utf8')).endpoints;
const projectContract = JSON.parse(readFileSync(new URL('../contract/workload-contract.json', import.meta.url), 'utf8')).projectCreate;
const manifestContract = JSON.parse(readFileSync(new URL('../contract/workload-contract.json', import.meta.url), 'utf8')).manifestCreate;
const PATH_TO_TYPE = Object.fromEntries(Object.entries(contract).map(([t, e]) => [e.path, t]));

const json = (status, body) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

export function createMockRunai({
  clientId = 'mock-app',
  clientSecret = 'mock-secret',
  clusters,
  projects = ['demo-team', 'research'],
  projectsByCluster, // optional: { <clusterUuid>: ['name', ...] } to make clusters differ
  overQuotaOff = [], // cluster uuids that reject overQuotaWeight when creating projects
} = {}) {
  const state = {
    tokensIssued: 0,
    expireTokens: false, // set true to force a 401 on the next call (token refresh test)
    failSubmit: {}, // clusterId -> {status, message, once}
    calls: [],
    workloads: [],
    clusters: clusters || [
      { uuid: 'c-west', name: 'cluster-a', state: 'Connected', total: 32, allocated: 20 },
      { uuid: 'c-osmo', name: 'cluster-b', state: 'Connected', total: 2, allocated: 0 },
      { uuid: 'c-off', name: 'offline-lab', state: 'Disconnected', total: 16, allocated: 0 },
    ],
  };
  const validTokens = new Set();
  const projectRecord = (c, name) => ({
    id: `p-${c.uuid}-${name}`, name, clusterId: c.uuid, status: { phase: 'Ready' },
    resources: [{ nodePool: { name: 'default' }, gpu: { deserved: Math.min(8, c.total), limit: -1 } }],
  });
  state.projects = state.clusters.flatMap((c) => (projectsByCluster?.[c.uuid] || projects).map((n) => projectRecord(c, n)));
  const free = (c) => c.total - c.allocated;

  async function fetchImpl(url, init = {}) {
    const u = new URL(url);
    const method = (init.method || 'GET').toUpperCase();
    const path = u.pathname;
    state.calls.push(`${method} ${path}${u.search}`);
    let body = null;
    try { body = init.body ? JSON.parse(init.body) : null; } catch { return json(400, { code: 400, message: 'invalid JSON' }); }

    if (path === '/api/v1/token' && method === 'POST') {
      if (body?.grantType !== 'client_credentials' || body.clientID !== clientId || body.clientSecret !== clientSecret) {
        return json(401, { code: 401, message: 'invalid client credentials' });
      }
      const tok = `tok-${++state.tokensIssued}`;
      validTokens.add(tok);
      return json(200, { accessToken: tok, expiresIn: 3600 });
    }

    const auth = (init.headers?.Authorization || '').replace('Bearer ', '');
    if (!validTokens.has(auth) || state.expireTokens) {
      state.expireTokens = false;
      validTokens.delete(auth);
      return json(401, { code: 401, message: 'authorization header is missing or invalid' });
    }

    if (path === '/api/v1/clusters' && method === 'GET') {
      return json(200, state.clusters.map((c) => ({
        uuid: c.uuid, name: c.name, version: '3.0.26', lastLiveness: new Date().toISOString(), status: { state: c.state },
      })));
    }

    if (path === '/api/v1/nodes/telemetry' && method === 'GET') {
      const type = u.searchParams.get('telemetryType');
      const f = {
        TOTAL_GPUS: (c) => c.total,
        FREE_GPUS: free,
        ALLOCATED_GPUS: (c) => c.allocated,
        READY_GPUS: (c) => (c.state === 'Connected' ? c.total : 0),
      }[type];
      if (!f) return json(400, { code: 400, message: `unsupported telemetryType ${type}` });
      return json(200, {
        type, timestamp: new Date().toISOString(),
        values: state.clusters.map((c) => ({ value: String(f(c)), groups: [{ key: 'ClusterId', value: c.uuid }] })),
      });
    }

    if (path === '/api/v1/org-unit/projects' && method === 'GET') {
      const all = state.projects;
      const off = Number(u.searchParams.get('offset') || 0);
      const lim = Number(u.searchParams.get('limit') || 100);
      const page = all.slice(off, off + lim);
      return json(200, { projects: page, ...(off + lim < all.length ? { next: off + lim } : {}) });
    }

    if (path === '/api/v1/org-unit/projects' && method === 'POST') {
      const bad = [];
      for (const k of Object.keys(body || {})) if (!projectContract.topKeys.includes(k)) bad.push(k);
      for (const k of projectContract.topRequired) if (body?.[k] === undefined) bad.push(`missing:${k}`);
      for (const r of body?.resources || []) {
        for (const k of Object.keys(r)) if (!projectContract.resourceKeys.includes(k)) bad.push(`resources.${k}`);
        for (const k of Object.keys(r.gpu || {})) if (!projectContract.gpuKeys.includes(k)) bad.push(`resources.gpu.${k}`);
        for (const k of Object.keys(r.nodePool || {})) if (!projectContract.nodePoolKeys.includes(k)) bad.push(`resources.nodePool.${k}`);
        for (const k of projectContract.nodePoolRequired) if (r.nodePool?.[k] === undefined) bad.push(`missing:resources.nodePool.${k}`);
      }
      if (bad.length) return json(400, { code: 400, message: `invalid request: ${bad.join(', ')}` });
      const cluster = state.clusters.find((c) => c.uuid === body.clusterId);
      if (!cluster) return json(400, { code: 400, message: 'unknown clusterId' });
      if (state.failProjectCreate?.[cluster.uuid]) return json(state.failProjectCreate[cluster.uuid], { code: state.failProjectCreate[cluster.uuid], message: 'injected project failure' });
      if (overQuotaOff.includes(cluster.uuid) && body.resources.some((r) => r.gpu?.overQuotaWeight !== undefined)) {
        return json(400, { code: 400, message: 'failed to create project: over quota feature is off. OverQuotaWeight should be deserved or empty in index 0' });
      }
      if (state.projects.some((p) => p.clusterId === cluster.uuid && p.name === body.name)) return json(409, { code: 409, message: 'project already exists' });
      const rec = projectRecord(cluster, body.name);
      state.projects.push(rec);
      state.projectCreates = (state.projectCreates || 0) + 1;
      return json(201, rec);
    }

    if (path === '/api/v1/node-pools' && method === 'GET') {
      return json(200, { nodepools: state.clusters.map((c) => ({ id: `np-${c.uuid}`, name: 'default', clusterId: c.uuid, isDefault: true })) });
    }

    if (path === '/api/v1/workloads' && method === 'GET') {
      let list = state.hideWorkloadList ? [] : [...state.workloads].reverse(); // hideWorkloadList simulates control-plane lag
      // GPUs held by load that no mock workload explains (what `cluster.allocated` was set to directly) are
      // listed as a "background" workload in the Initializing phase (a GPU-holding phase that is not counted
      // as running). state.hideBackground = true simulates usage Run:ai workloads do not show (non-Run:ai pods).
      if (!state.hideWorkloadList && !state.hideBackground && u.searchParams.getAll('filterBy').includes('phase==Initializing')) {
        for (const c of state.clusters) {
          const explained = state.workloads.filter((w) => w.clusterId === c.uuid && w.phase === 'Running').reduce((a, w) => a + (w.allocatedResources?.gpu || 0), 0);
          const bg = c.pools ? 0 : Math.max(0, c.allocated - explained);
          if (bg > 0) list.push({ id: `bg-${c.uuid}`, name: 'background', clusterId: c.uuid, phase: 'Initializing', allocatedResources: { gpu: bg } });
        }
      }
      for (const f of u.searchParams.getAll('filterBy')) {
        const m = /^phase==(.+)$/.exec(f);
        if (m) list = list.filter((w) => w.phase === m[1]);
      }
      const off = Number(u.searchParams.get('offset') || 0);
      const lim = Number(u.searchParams.get('limit') || 100);
      return json(200, { workloads: list.slice(off, off + lim), ...(off + lim < list.length ? { next: off + lim } : {}) });
    }

    if (path === '/api/v2/workloads' && method === 'POST') {
      const bad = [];
      for (const k of Object.keys(body || {})) if (!manifestContract.topKeys.includes(k)) bad.push(k);
      for (const k of manifestContract.topRequired) if (body?.[k] === undefined) bad.push(`missing:${k}`);
      for (const k of Object.keys(body?.metadata || {})) if (!manifestContract.metadataKeys.includes(k)) bad.push(`metadata.${k}`);
      if (body?.manifest !== undefined && body?.manifestBase64Encoded !== undefined) bad.push('manifest and manifestBase64Encoded are mutually exclusive');
      if (body?.manifest === undefined && body?.manifestBase64Encoded === undefined) bad.push('missing:manifest');
      if (bad.length) return json(400, { code: 400, message: `invalid request: ${bad.join(', ')}` });
      // Like the real API: projectId and clusterId are mutually exclusive; the project selects the cluster.
      if (body.metadata.projectId && body.metadata.clusterId) {
        return json(400, [{ code: 400, message: 'projectId and clusterId are mutually exclusive, provide only one', complianceIssues: [{ field: 'project', details: 'projectId and clusterId are mutually exclusive, provide only one' }] }]);
      }
      const project = state.projects.find((p) => p.id === body.metadata.projectId);
      if (!project) return json(400, { code: 400, message: 'unknown projectId' });
      const cluster = state.clusters.find((c) => c.uuid === project.clusterId);
      const inj = state.failSubmit[cluster.uuid];
      if (inj) { if (inj.once) delete state.failSubmit[cluster.uuid]; return json(inj.status, { code: inj.status, message: inj.message || 'injected failure' }); }
      if (cluster.state !== 'Connected') return json(503, { code: 503, message: 'cluster not connected' });
      let text;
      try { text = body.manifestBase64Encoded !== undefined ? Buffer.from(body.manifestBase64Encoded, 'base64').toString('utf8') : JSON.stringify(body.manifest); } catch { return json(400, { code: 400, message: 'manifest is not valid base64' }); }
      const parsed = parseManifest(text);
      if (!parsed.ok) return json(400, { code: 400, message: `invalid manifest: ${parsed.errors[0].message}` });
      const doc = (await import('./vendor/js-yaml.mjs')).load(text);
      const need = detectManifestGpus(doc).gpus ?? 0;
      const fits = free(cluster) >= need;
      if (fits) { if (cluster.pools) { /* flat clusters only in this mock */ } else cluster.allocated += need; }
      const id = `wl-${state.workloads.length + 1}`;
      const name = body.metadata.name || doc.metadata?.name || `workload-${id}`;
      state.workloads.push({
        workloadId: id, id, name, clusterId: cluster.uuid, projectId: project.id, projectName: project.name,
        actualPhase: fits ? 'Running' : 'Pending', phase: fits ? 'Running' : 'Pending', desiredPhase: 'Running',
        type: doc.kind, createdAt: new Date().toISOString(), allocatedResources: { gpu: fits ? need : 0 }, viaManifest: true,
      });
      return json(202, { metadata: { id, name, projectId: project.id, clusterId: cluster.uuid, projectName: project.name }, desiredPhase: 'Running' });
    }

    const type = PATH_TO_TYPE[path];
    if (type && method === 'POST') {
      const ct = contract[type];
      const bad = [];
      for (const k of Object.keys(body || {})) if (!ct.topKeys.includes(k)) bad.push(k);
      for (const k of ct.topRequired) if (body?.[k] === undefined) bad.push(`missing:${k}`);
      for (const k of Object.keys(body?.spec || {})) if (!ct.specKeys.includes(k)) bad.push(`spec.${k}`);
      for (const k of Object.keys(body?.spec?.compute || {})) if (!ct.computeKeys.includes(k)) bad.push(`spec.compute.${k}`);
      const gt = body?.spec?.compute?.gpuRequestType;
      if (gt && !ct.enums.gpuRequestType.includes(gt)) bad.push(`spec.compute.gpuRequestType=${gt}`);
      const fw = body?.spec?.distributedFramework;
      if (fw && !ct.enums.distributedFramework.includes(fw)) bad.push(`spec.distributedFramework=${fw}`);
      if (bad.length) return json(400, { code: 400, message: `invalid request: ${bad.join(', ')}` });

      const cluster = state.clusters.find((c) => c.uuid === body.clusterId);
      if (!cluster) return json(400, { code: 400, message: 'unknown clusterId' });
      const inj = state.failSubmit[cluster.uuid];
      if (inj) {
        if (inj.once) delete state.failSubmit[cluster.uuid];
        return json(inj.status, { code: inj.status, message: inj.message || 'injected failure' });
      }
      if (cluster.state !== 'Connected') return json(503, { code: 503, message: 'cluster not connected' });

      const c = body.spec?.compute || {};
      const per = c.gpuPortionRequest ?? c.gpuDevicesRequest ?? 0;
      const pods = type === 'distributed' ? (body.spec.numWorkers + (body.spec.distributedFramework === 'MPI' ? 0 : 1)) : 1;
      const need = per * pods;
      const phase = free(cluster) >= need ? 'Running' : 'Pending';
      if (phase === 'Running') cluster.allocated += need;
      const wl = {
        // creation response fields
        workloadId: `wl-${state.workloads.length + 1}`, name: body.name, clusterId: cluster.uuid, projectId: body.projectId,
        actualPhase: phase, desiredPhase: 'Running', createdAt: new Date().toISOString(),
        // list-item fields (as returned by GET /api/v1/workloads)
        id: `wl-${state.workloads.length + 1}`, type: type[0].toUpperCase() + type.slice(1), phase,
        projectName: state.projects.find((p) => p.id === body.projectId)?.name || null,
        allocatedResources: { gpu: phase === 'Running' ? need : 0 },
      };
      state.workloads.push(wl);
      return json(202, wl);
    }

    return json(404, { code: 404, message: `no mock for ${method} ${path}` });
  }

  return { fetch: fetchImpl, state, credentials: { clientId, clientSecret } };
}
