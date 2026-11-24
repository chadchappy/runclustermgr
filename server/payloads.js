// Turns a simple, UI-friendly workload request into a Run:ai API v1 creation
// payload. Field names here are checked against the OpenAPI spec by
// test/contract.test.js (using contract/workload-contract.json).

export const TYPES = ['workspace', 'training', 'distributed', 'inference', 'manifest'];
export const FRAMEWORKS = ['PyTorch', 'TF', 'MPI', 'XGBoost', 'JAX'];

const ENDPOINTS = {
  workspace: '/api/v1/workloads/workspaces',
  training: '/api/v1/workloads/trainings',
  distributed: '/api/v1/workloads/distributed',
  inference: '/api/v1/workloads/inferences',
  manifest: '/api/v2/workloads', // Kubernetes manifest: the endpoint `runai workload submit -f` uses
};

const NAME_RE = /^[a-z0-9]([-a-z0-9]*[a-z0-9])?$/;
const MEM_RE = /^\d+(\.\d+)?(M|G|Mi|Gi)$/;
const ENV_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;

export function validateRequest(r) {
  const errors = [];
  if (!r || typeof r !== 'object') return ['request body must be a JSON object'];
  if (r.type === 'manifest') {
    // A manifest is checked in depth by server/intake.js; here only what submission needs.
    if (typeof r.project !== 'string' || !r.project) errors.push('project is required');
    if (typeof r.manifestText !== 'string' || !r.manifestText.trim()) errors.push('manifest is required');
    if (r.name !== null && r.name !== undefined && (typeof r.name !== 'string' || r.name.length > 253)) errors.push('manifest name is invalid');
    const g = Number(r.gpus ?? 0);
    if (!Number.isFinite(g) || g < 0 || g > 4096) errors.push('gpus must be a number of 0 or more');
    return errors;
  }
  if (!TYPES.includes(r.type)) errors.push(`type must be one of ${TYPES.join(', ')}`);
  if (typeof r.name !== 'string' || !NAME_RE.test(r.name) || r.name.length > 63) {
    errors.push('name must be lowercase letters, digits or "-" (max 63 chars, start/end alphanumeric)');
  }
  if (typeof r.project !== 'string' || !r.project) errors.push('project is required');
  if (typeof r.image !== 'string' || !r.image.trim()) errors.push('image is required');
  const g = Number(r.gpus ?? 0);
  if (!Number.isFinite(g) || g < 0 || g > 64) errors.push('gpus must be a number between 0 and 64');
  else if (g > 1 && !Number.isInteger(g)) errors.push('gpus above 1 must be a whole number (use a value below 1 for a fractional GPU)');
  if (r.cpu !== undefined && r.cpu !== '' && !(Number(r.cpu) > 0)) errors.push('cpu must be a positive number of cores');
  if (r.memory !== undefined && r.memory !== '' && !MEM_RE.test(String(r.memory))) errors.push('memory must look like 512M or 4G');
  if (r.env !== undefined) {
    if (typeof r.env !== 'object' || Array.isArray(r.env) || r.env === null) errors.push('env must be an object of NAME: value');
    else for (const k of Object.keys(r.env)) if (!ENV_RE.test(k)) errors.push(`invalid environment variable name "${k}"`);
  }
  if (r.type === 'distributed') {
    if (!FRAMEWORKS.includes(r.framework || 'PyTorch')) errors.push(`framework must be one of ${FRAMEWORKS.join(', ')}`);
    const w = Number(r.workers ?? 2);
    if (!Number.isInteger(w) || w < 1 || w > 64) errors.push('workers must be a whole number between 1 and 64');
  }
  if (r.type === 'inference' && r.port !== undefined && r.port !== '') {
    const p = Number(r.port);
    if (!Number.isInteger(p) || p < 1 || p > 65535) errors.push('port must be 1-65535');
  }
  return errors;
}

// Total GPU units this request will occupy (used for placement).
export function gpuDemand(r) {
  if (r.type === 'manifest') return Number(r.gpus ?? 0); // total, already counted over replicas
  const per = Number(r.gpus ?? 0);
  if (r.type === 'distributed') {
    const workers = Number(r.workers ?? 2);
    // PyTorch/TF/XGBoost/JAX run a master pod that gets the same spec; an MPI
    // launcher does not request GPUs.
    const masters = (r.framework || 'PyTorch') === 'MPI' ? 0 : 1;
    return per * (workers + masters);
  }
  return per;
}

function compute(r) {
  const c = {};
  const g = Number(r.gpus ?? 0);
  if (g > 0 && g < 1) {
    c.gpuDevicesRequest = 1;
    c.gpuRequestType = 'portion';
    c.gpuPortionRequest = g;
  } else if (g >= 1) {
    c.gpuDevicesRequest = g;
  } else {
    c.gpuDevicesRequest = 0;
  }
  if (r.cpu) c.cpuCoreRequest = Number(r.cpu);
  if (r.memory) c.cpuMemoryRequest = String(r.memory);
  return c;
}

export function buildPayload(r, { projectId, clusterId }) {
  const errors = validateRequest(r);
  if (errors.length) throw Object.assign(new Error(errors.join('; ')), { validation: errors });

  if (r.type === 'manifest') {
    return {
      path: ENDPOINTS.manifest,
      body: {
        // projectId and clusterId are mutually exclusive on this endpoint: a project belongs to one
        // cluster, so the project id alone selects both (Run:ai rejects the pair with HTTP 400)
        metadata: { ...(r.name ? { name: r.name } : {}), projectId },
        manifestBase64Encoded: Buffer.from(r.manifestText, 'utf8').toString('base64'),
      },
    };
  }

  const spec = {
    image: r.image.trim(),
    compute: compute(r),
  };
  if (r.command) spec.command = String(r.command);
  if (r.args) spec.args = String(r.args);
  if (r.env && Object.keys(r.env).length) {
    spec.environmentVariables = Object.entries(r.env).map(([name, value]) => ({ name, value: String(value) }));
  }
  if (r.nodePool) spec.nodePools = [r.nodePool];

  const body = { name: r.name, ...(r.namePrefix ? { useGivenNameAsPrefix: true } : {}), projectId, clusterId, spec };

  if (r.type === 'distributed') {
    spec.distributedFramework = r.framework || 'PyTorch';
    spec.numWorkers = Number(r.workers ?? 2);
    body.masterSpecSameAsWorker = true;
  }
  if (r.type === 'inference') {
    spec.servingPort = { container: Number(r.port || 8000), protocol: 'http' };
  }
  return { path: ENDPOINTS[r.type], body };
}

// A project to create on a cluster that does not have the requested one. It carries no guaranteed
// GPU quota (deserved: 0): workloads run on over-quota capacity. Clusters with the over-quota
// feature turned off reject the weight, so callers retry with `overQuota: false`.
export function buildProjectPayload({ name, clusterId, nodePoolId, nodePoolName, overQuota = true }) {
  if (!NAME_RE.test(name) || name.length > 63) throw new Error(`cannot create a project named "${name}"`);
  const gpu = { deserved: 0, ...(overQuota ? { overQuotaWeight: 1 } : {}) };
  return {
    name,
    clusterId,
    description: 'Created on demand by the Run:ai Multi-Cluster Scheduling Portal',
    resources: [{ nodePool: { id: String(nodePoolId), ...(nodePoolName ? { name: nodePoolName } : {}) }, gpu }],
  };
}
