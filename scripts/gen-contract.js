#!/usr/bin/env node
// Generates contract/workload-contract.json from a Run:ai OpenAPI spec (JSON).
// The control plane serves the spec as YAML at https://<control-plane>/api/docs.
// Convert with:  yq -o=json . openapi.yaml > openapi.json
// Usage: node scripts/gen-contract.js openapi.json [--out contract/workload-contract.json]
import { readFileSync, writeFileSync } from 'node:fs';

const [, , specPath, ...rest] = process.argv;
if (!specPath) {
  console.error('usage: gen-contract.js <openapi.json> [--out file]');
  process.exit(2);
}
const out = rest[rest.indexOf('--out') + 1] || new URL('../contract/workload-contract.json', import.meta.url).pathname;
const s = JSON.parse(readFileSync(specPath, 'utf8'));

const get = (r) => r.$ref.replace('#/', '').split('/').reduce((a, k) => a[k], s);
const flat = (o) => {
  if (!o) return { properties: {}, required: [] };
  if (o.$ref) return flat(get(o));
  const properties = { ...(o.properties || {}) };
  const required = [...(o.required || [])];
  for (const a of o.allOf || []) {
    const f = flat(a);
    Object.assign(properties, f.properties);
    required.push(...f.required);
  }
  return { properties, required: [...new Set(required)], enum: o.enum };
};

const endpoints = {};
for (const [type, path] of [
  ['workspace', '/api/v1/workloads/workspaces'],
  ['training', '/api/v1/workloads/trainings'],
  ['distributed', '/api/v1/workloads/distributed'],
  ['inference', '/api/v1/workloads/inferences'],
]) {
  const top = flat(s.paths[path].post.requestBody.content['application/json'].schema);
  const spec = flat(top.properties.spec);
  const compute = flat(spec.properties.compute);
  const e = { path, topKeys: Object.keys(top.properties).sort(), topRequired: top.required.sort(), specKeys: Object.keys(spec.properties).sort(), computeKeys: Object.keys(compute.properties).sort() };
  const enums = {};
  if (compute.properties.gpuRequestType) enums.gpuRequestType = flat(compute.properties.gpuRequestType).enum;
  if (spec.properties.distributedFramework) enums.distributedFramework = flat(spec.properties.distributedFramework).enum;
  if (spec.properties.servingPort) {
    const sp = flat(spec.properties.servingPort);
    e.servingPortKeys = Object.keys(sp.properties).sort();
    enums.servingProtocol = flat(sp.properties.protocol).enum;
  }
  const ev = spec.properties.environmentVariables;
  if (ev) {
    const arr = ev.$ref ? get(ev) : ev;
    e.envVarKeys = Object.keys(flat(arr.items).properties).sort();
  }
  e.enums = enums;
  endpoints[type] = e;
}

// Project creation (used for on-demand projects on clusters that lack one)
const proj = flat(s.paths['/api/v1/org-unit/projects'].post.requestBody.content['application/json'].schema);
const resArr = proj.properties.resources.$ref ? get(proj.properties.resources) : proj.properties.resources;
const resItem = flat(resArr.items);
const projectCreate = {
  path: '/api/v1/org-unit/projects',
  topKeys: Object.keys(proj.properties).sort(),
  topRequired: proj.required.sort(),
  resourceKeys: Object.keys(resItem.properties).sort(),
  gpuKeys: Object.keys(flat(resItem.properties.gpu).properties).sort(),
  nodePoolKeys: Object.keys(flat(resItem.properties.nodePool).properties).sort(),
  nodePoolRequired: flat(resItem.properties.nodePool).required.sort(),
};

// Manifest (Kubernetes YAML) submission: POST /api/v2/workloads, the endpoint `runai workload submit -f` uses
const v2 = flat(s.paths['/api/v2/workloads'].post.requestBody.content['application/json'].schema);
const v2meta = flat(v2.properties.metadata);
const manifestCreate = {
  path: '/api/v2/workloads',
  topKeys: Object.keys(v2.properties).sort(),
  topRequired: v2.required.sort(),
  metadataKeys: Object.keys(v2meta.properties).sort(),
};

writeFileSync(out, JSON.stringify({ generatedFrom: `${s.info.title} ${s.info.version}`, endpoints, projectCreate, manifestCreate }, null, 2) + '\n');
console.log(`wrote ${out}`);
