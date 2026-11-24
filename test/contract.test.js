// Compliance with the Run:ai API: every field we send must exist in the OpenAPI
// spec for that endpoint. contract/workload-contract.json is generated from the
// control plane's spec by scripts/gen-contract.js. Regenerate it when you
// upgrade Run:ai, and this suite tells you what broke.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { buildPayload, FRAMEWORKS, TYPES } from '../server/payloads.js';

const contract = JSON.parse(readFileSync(new URL('../contract/workload-contract.json', import.meta.url), 'utf8')).endpoints;
const ctx = { projectId: 'p1', clusterId: 'c1' };

const variants = [
  { gpus: 0 },
  { gpus: 1 },
  { gpus: 8 },
  { gpus: 0.25 },
  { gpus: 2, cpu: 4, memory: '16G' },
  { gpus: 1, env: { FOO: 'bar' }, command: 'python', args: '-m http.server' },
  { gpus: 1, nodePool: 'default' },
];

for (const type of TYPES) {
  test(`${type}: payloads only use fields defined by the API spec`, () => {
    const ct = contract[type];
    const extra = type === 'distributed' ? FRAMEWORKS.map((framework) => ({ framework, workers: 2 })) : type === 'inference' ? [{ port: 8080 }, {}] : [{}];
    for (const v of variants) {
      for (const e of extra) {
        const { path, body } = buildPayload({ type, name: 'x1', project: 'team', image: 'img:1', ...v, ...e }, ctx);
        const label = JSON.stringify({ ...v, ...e });
        assert.equal(path, ct.path);
        for (const k of Object.keys(body)) assert.ok(ct.topKeys.includes(k), `${type} ${label}: unknown top-level field "${k}"`);
        for (const k of ct.topRequired) assert.notEqual(body[k], undefined, `${type} ${label}: missing required "${k}"`);
        for (const k of Object.keys(body.spec)) assert.ok(ct.specKeys.includes(k), `${type} ${label}: unknown spec field "${k}"`);
        for (const k of Object.keys(body.spec.compute)) assert.ok(ct.computeKeys.includes(k), `${type} ${label}: unknown compute field "${k}"`);
        for (const ev of body.spec.environmentVariables || []) {
          for (const k of Object.keys(ev)) assert.ok(ct.envVarKeys.includes(k), `${type}: unknown env var field "${k}"`);
        }
        if (body.spec.compute.gpuRequestType) assert.ok(ct.enums.gpuRequestType.includes(body.spec.compute.gpuRequestType));
        if (body.spec.distributedFramework) assert.ok(ct.enums.distributedFramework.includes(body.spec.distributedFramework));
        if (body.spec.servingPort) {
          for (const k of Object.keys(body.spec.servingPort)) assert.ok(ct.servingPortKeys.includes(k), `unknown servingPort field "${k}"`);
          assert.ok(ct.enums.servingProtocol.includes(body.spec.servingPort.protocol));
        }
      }
    }
  });
}

test('every framework we expose is accepted by the API enum', () => {
  for (const f of FRAMEWORKS) assert.ok(contract.distributed.enums.distributedFramework.includes(f), `${f} not in API enum`);
});

test('regression: the legacy v1 app sent compute.cpu / compute.memory, which the API does not define', () => {
  for (const type of TYPES) {
    assert.ok(!contract[type].computeKeys.includes('cpu'));
    assert.ok(!contract[type].computeKeys.includes('memory'));
    assert.ok(contract[type].computeKeys.includes('cpuCoreRequest'));
    assert.ok(contract[type].computeKeys.includes('cpuMemoryRequest'));
  }
});
