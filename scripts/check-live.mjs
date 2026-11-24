#!/usr/bin/env node
// Read-only API compatibility check against a real Run:ai control plane.
// Verifies that every endpoint and response shape this app depends on is what the
// control plane actually returns, and reports the control plane's API version.
//
//   RUNAI_CONTROL_PLANE=host RUNAI_CLIENT_ID=app RUNAI_CLIENT_SECRET_FILE=~/.secrets/x node scripts/check-live.mjs
//
// Exit code 0 = compatible, 1 = something this app relies on is missing or changed.
import { readFileSync } from 'node:fs';
import { RunaiClient } from '../server/runai-client.js';
import { collectSnapshot } from '../server/capacity.js';

const read = (p) => readFileSync(p.replace(/^~/, process.env.HOME), 'utf8').trim();
const host = (process.env.RUNAI_CONTROL_PLANE || '').replace(/^https?:\/\//, '');
const id = process.env.RUNAI_CLIENT_ID || (process.env.RUNAI_CLIENT_ID_FILE && read(process.env.RUNAI_CLIENT_ID_FILE));
const secret = process.env.RUNAI_CLIENT_SECRET || (process.env.RUNAI_CLIENT_SECRET_FILE && read(process.env.RUNAI_CLIENT_SECRET_FILE));
if (!host || !id || !secret) { console.error('set RUNAI_CONTROL_PLANE, RUNAI_CLIENT_ID and RUNAI_CLIENT_SECRET(_FILE)'); process.exit(2); }

const client = new RunaiClient({ baseUrl: `https://${host}`, clientId: id, clientSecret: secret });
let failed = 0;
const check = async (name, fn) => {
  try {
    const detail = await fn();
    console.log(`  ok    ${name}${detail ? `  (${detail})` : ''}`);
  } catch (e) {
    failed++;
    console.log(`  FAIL  ${name}: ${e.message}`);
  }
};
const must = (cond, msg) => { if (!cond) throw new Error(msg); };

console.log(`Run:ai API compatibility check: ${host} as "${id}"`);

await check('auth: client_credentials token', async () => { await client.authenticate(); return 'token issued'; });

let clusters = [];
await check('GET /api/v1/clusters', async () => {
  clusters = await client.get('/api/v1/clusters');
  must(Array.isArray(clusters) && clusters.length, 'expected a non-empty array');
  for (const c of clusters) must(c.uuid && c.name && c.status && 'state' in c.status, `cluster missing uuid/name/status.state: ${JSON.stringify(c).slice(0, 120)}`);
  return clusters.map((c) => `${c.name} ${c.status.state}`).join(', ');
});

for (const type of ['TOTAL_GPUS', 'FREE_GPUS', 'ALLOCATED_GPUS', 'READY_GPUS']) {
  await check(`GET /api/v1/nodes/telemetry ${type} groupBy=ClusterId`, async () => {
    const r = await client.get('/api/v1/nodes/telemetry', { telemetryType: type, groupBy: ['ClusterId'] });
    must(Array.isArray(r.values), 'no values array');
    for (const v of r.values) must(v.groups?.some((g) => g.key === 'ClusterId') && Number.isFinite(Number(v.value)), `bad value item ${JSON.stringify(v).slice(0, 120)}`);
    return `${r.values.length} cluster(s)`;
  });
}

let projects = [];
await check('GET /api/v1/org-unit/projects (paged)', async () => {
  projects = await client.list('/api/v1/org-unit/projects', 'projects');
  for (const p of projects) must(p.id && p.name && p.clusterId, `project missing id/name/clusterId: ${JSON.stringify(p).slice(0, 120)}`);
  return `${projects.length} project(s)`;
});

await check('GET /api/v1/workloads + filterBy=phase==Pending', async () => {
  const all = await client.get('/api/v1/workloads', { limit: 5 });
  must(Array.isArray(all.workloads), 'no workloads array');
  for (const w of all.workloads) must(w.name && w.clusterId && 'phase' in w, `workload missing name/clusterId/phase: ${Object.keys(w).slice(0, 8)}`);
  const f = await client.get('/api/v1/workloads', { limit: 5, filterBy: ['phase==Pending'] });
  must(Array.isArray(f.workloads), 'filterBy not accepted');
  must(f.workloads.every((w) => w.phase === 'Pending'), 'filterBy returned non-Pending workloads');
  return 'list + filter ok';
});

await check('app snapshot builds from live data (capacity.js)', async () => {
  const snap = await collectSnapshot(client);
  must(snap.errors.length === 0, `snapshot errors: ${snap.errors.join('; ')}`);
  for (const c of snap.clusters) must(c.gpu.total !== null && c.gpu.free !== null, `${c.name}: GPU numbers missing`);
  return snap.clusters.map((c) => `${c.name}: ${c.gpu.free}/${c.gpu.total} free`).join(', ');
});

console.log(failed ? `\n${failed} check(s) failed: this control plane is not fully compatible.` : '\nAll checks passed: this control plane is compatible.');
process.exit(failed ? 1 : 0);
