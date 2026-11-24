// Configuration comes only from the environment (or mounted secret files).
// Nothing here has a default credential: a missing secret is a startup error
// unless MOCK=1 is set.
import { readFileSync } from 'node:fs';

function fromFileOrEnv(name) {
  const file = process.env[`${name}_FILE`];
  if (file) {
    try {
      return readFileSync(file, 'utf8').trim();
    } catch (e) {
      throw new Error(`Cannot read ${name}_FILE (${file}): ${e.message}`);
    }
  }
  return process.env[name];
}

function list(v) {
  return (v || '').split(',').map((s) => s.trim()).filter(Boolean);
}

export function loadConfig(env = process.env) {
  const mock = env.MOCK === '1' || env.MOCK === 'true';
  const cfg = {
    port: Number(env.PORT || 3000),
    mock,
    controlPlane: (env.RUNAI_CONTROL_PLANE || '').replace(/^https?:\/\//, '').replace(/\/+$/, ''),
    clientId: fromFileOrEnv('RUNAI_CLIENT_ID'),
    clientSecret: fromFileOrEnv('RUNAI_CLIENT_SECRET'),
    // Optional UI protection (HTTP basic auth). Strongly recommended when
    // exposed through an ingress.
    uiUser: env.UI_USER || '',
    uiPassword: fromFileOrEnv('UI_PASSWORD') || '',
    capacityTtlMs: Number(env.CAPACITY_TTL_MS || 4000),
    reservationTtlMs: Number(env.RESERVATION_TTL_MS || 90000),
    requestTimeoutMs: Number(env.REQUEST_TIMEOUT_MS || 20000),
    // How GPU usage is measured: 'workloads' (default, fastest to reflect changes), 'max' or 'telemetry'
    usageSource: ['workloads', 'max', 'telemetry'].includes(env.USAGE_SOURCE) ? env.USAGE_SOURCE : 'workloads',
    policy: {
      excludeClusters: list(env.EXCLUDE_CLUSTERS), // names or uuids
      allowUnknownCapacity: env.ALLOW_UNKNOWN_CAPACITY === 'true',
      // Let a workload run on a cluster that lacks the chosen project by creating a matching
      // project there on demand. Changes Run:ai org structure, so it is opt-in.
      autoCreateProjects: env.AUTO_CREATE_PROJECTS === 'true',
      // When nothing fits right now: 'queue' places on the best cluster anyway
      // (Run:ai queues it); 'reject' returns an error.
      noFitStrategy: env.NO_FIT_STRATEGY === 'reject' ? 'reject' : 'queue',
    },
  };
  if (!mock) {
    const missing = [];
    if (!cfg.controlPlane) missing.push('RUNAI_CONTROL_PLANE');
    if (!cfg.clientId) missing.push('RUNAI_CLIENT_ID');
    if (!cfg.clientSecret) missing.push('RUNAI_CLIENT_SECRET');
    if (missing.length) {
      throw new Error(`Missing required configuration: ${missing.join(', ')} (or set MOCK=1)`);
    }
  }
  if (cfg.uiUser && !cfg.uiPassword) {
    throw new Error('UI_USER is set but UI_PASSWORD is empty');
  }
  return cfg;
}
