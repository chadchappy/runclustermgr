#!/usr/bin/env node
// Live end-to-end QA through a DEPLOYED Cluster Manager: submits one small workload of every
// type, checks Run:ai accepted it and where it was placed, then deletes everything it created.
//
//   BASE_URL=https://clustermgr.example.com UI_USER=admin UI_PASSWORD=... PROJECT=msched-demo \
//   RUNAI_CONTROL_PLANE=host RUNAI_CLIENT_ID=app RUNAI_CLIENT_SECRET_FILE=~/.secrets/x node scripts/qa-live.mjs
//
// PROJECT must exist on the clusters you want exercised. Workloads are named qa-<random>-<type>
// and use the tiny busybox image; GPU use is small (<= 1 GPU, one fractional).
import { readFileSync } from 'node:fs';
import { RunaiClient } from '../server/runai-client.js';

const env = process.env;
const read = (p) => readFileSync(p.replace(/^~/, env.HOME), 'utf8').trim();
const BASE = (env.BASE_URL || '').replace(/\/$/, '');
const PROJECT = env.PROJECT || 'msched-demo';
const secret = env.RUNAI_CLIENT_SECRET || (env.RUNAI_CLIENT_SECRET_FILE && read(env.RUNAI_CLIENT_SECRET_FILE));
const id = env.RUNAI_CLIENT_ID || (env.RUNAI_CLIENT_ID_FILE && read(env.RUNAI_CLIENT_ID_FILE));
if (!BASE || !env.RUNAI_CONTROL_PLANE || !id || !secret) { console.error('set BASE_URL, RUNAI_CONTROL_PLANE, RUNAI_CLIENT_ID, RUNAI_CLIENT_SECRET(_FILE) (and UI_USER/UI_PASSWORD if the app has auth)'); process.exit(2); }

const authz = env.UI_USER ? { Authorization: 'Basic ' + Buffer.from(`${env.UI_USER}:${env.UI_PASSWORD || ''}`).toString('base64') } : {};
const app = async (method, path, body) => {
  const r = await fetch(BASE + path, { method, headers: { 'Content-Type': 'application/json', ...authz }, body: body ? JSON.stringify(body) : undefined });
  const t = await r.text(); let j; try { j = JSON.parse(t); } catch { j = t; }
  return { status: r.status, body: j };
};
const runai = new RunaiClient({ baseUrl: `https://${env.RUNAI_CONTROL_PLANE.replace(/^https?:\/\//, '')}`, clientId: id, clientSecret: secret });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const tag = Math.random().toString(36).slice(2, 6);
const base = { project: PROJECT, image: 'busybox:1.36' };
const DELETE_PATH = { workspace: 'workspaces', training: 'trainings', distributed: 'distributed', inference: 'inferences' };

const cases = [
  { label: 'training, 1 GPU (auto-placed)', req: { ...base, type: 'training', gpus: 1, command: 'sleep', args: '300' } },
  { label: 'workspace, 0.5 GPU (fractional)', req: { ...base, type: 'workspace', gpus: 0.5, command: 'sleep', args: '300' } },
  { label: 'distributed PyTorch, 1 worker (CPU)', req: { ...base, type: 'distributed', framework: 'PyTorch', workers: 1, gpus: 0, command: 'sleep', args: '300' } },
  { label: 'distributed MPI, 1 worker (CPU)', req: { ...base, type: 'distributed', framework: 'MPI', workers: 1, gpus: 0, command: 'sleep', args: '300' } },
  { label: 'inference, CPU, port 8000', req: { ...base, type: 'inference', gpus: 0, port: 8000, image: 'hashicorp/http-echo:1.0', args: '-listen=:8000' } },
  { label: 'training, CPU-only', req: { ...base, type: 'training', gpus: 0, command: 'sleep', args: '300' } },
];

console.log(`Live QA via ${BASE}, project "${PROJECT}"\n`);
let failed = 0;
const created = [];
for (const [i, c] of cases.entries()) {
  const name = `qa-${tag}-${i + 1}`;
  const r = await app('POST', '/api/workloads', { ...c.req, name });
  if (r.status === 202 && r.body.workload) {
    const w = r.body.workload;
    created.push({ name, type: c.req.type, id: w.workloadId || w.id, clusterId: w.clusterId });
    console.log(`  ok    ${c.label.padEnd(40)} -> ${r.body.placement.chosenName}${r.body.placement.queued ? ' (queued)' : ''}`);
  } else {
    failed++;
    console.log(`  FAIL  ${c.label.padEnd(40)} -> HTTP ${r.status}: ${typeof r.body === 'string' ? r.body.slice(0, 200) : r.body.error}`);
  }
}

if (created.length) {
  console.log('\nWaiting 45s for Run:ai to schedule...');
  await sleep(45000);
  const list = await runai.get('/api/v1/workloads', { limit: 100 });
  const byName = new Map((list.workloads || []).map((w) => [w.name, w]));
  const cl = new Map((await runai.get('/api/v1/clusters')).map((c) => [c.uuid, c.name]));
  for (const w of created) {
    const live = byName.get(w.name);
    if (!live) { failed++; console.log(`  FAIL  ${w.name} (${w.type}) is not visible in Run:ai`); continue; }
    console.log(`  seen  ${w.name} ${w.type.padEnd(12)} cluster=${cl.get(live.clusterId)} phase=${live.phase}`);
  }
}

console.log('\nCleaning up...');
for (const w of created) {
  try { await runai.request('DELETE', `/api/v1/workloads/${DELETE_PATH[w.type]}/${w.id}`); console.log(`  deleted ${w.name}`); }
  catch (e) { failed++; console.log(`  FAIL deleting ${w.name}: ${e.message}`); }
}

console.log(failed ? `\n${failed} problem(s).` : '\nAll workload types accepted by Run:ai and cleaned up.');
process.exit(failed ? 1 : 0);
