import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildPayload, gpuDemand, validateRequest } from '../server/payloads.js';

const base = { type: 'training', name: 'job-1', project: 'team', image: 'nvcr.io/nvidia/pytorch:24.01-py3', gpus: 1 };
const ctx = { projectId: 'p1', clusterId: 'c1' };

test('whole GPUs use gpuDevicesRequest only', () => {
  const { path, body } = buildPayload({ ...base, gpus: 4 }, ctx);
  assert.equal(path, '/api/v1/workloads/trainings');
  assert.deepEqual(body.spec.compute, { gpuDevicesRequest: 4 });
  assert.equal(body.projectId, 'p1');
  assert.equal(body.clusterId, 'c1');
});

test('fractional GPU uses portion request on one device', () => {
  const { body } = buildPayload({ ...base, gpus: 0.5 }, ctx);
  assert.deepEqual(body.spec.compute, { gpuDevicesRequest: 1, gpuRequestType: 'portion', gpuPortionRequest: 0.5 });
});

test('cpu/memory map to the real field names (not cpu/memory)', () => {
  const { body } = buildPayload({ ...base, cpu: 2, memory: '8G' }, ctx);
  assert.equal(body.spec.compute.cpuCoreRequest, 2);
  assert.equal(body.spec.compute.cpuMemoryRequest, '8G');
  assert.equal(body.spec.compute.cpu, undefined);
  assert.equal(body.spec.compute.memory, undefined);
});

test('env, command, args and node pool', () => {
  const { body } = buildPayload({ ...base, env: { A: 1, B: 'x' }, command: 'python', args: 'train.py --lr 0.1', nodePool: 'h100' }, ctx);
  assert.deepEqual(body.spec.environmentVariables, [{ name: 'A', value: '1' }, { name: 'B', value: 'x' }]);
  assert.equal(body.spec.command, 'python');
  assert.equal(body.spec.args, 'train.py --lr 0.1');
  assert.deepEqual(body.spec.nodePools, ['h100']);
});

test('each type maps to its endpoint', () => {
  const paths = Object.fromEntries(['workspace', 'training', 'distributed', 'inference'].map((type) => [type, buildPayload({ ...base, type }, ctx).path]));
  assert.deepEqual(paths, {
    workspace: '/api/v1/workloads/workspaces',
    training: '/api/v1/workloads/trainings',
    distributed: '/api/v1/workloads/distributed',
    inference: '/api/v1/workloads/inferences',
  });
});

test('distributed: framework, workers, masterSpecSameAsWorker', () => {
  const { body } = buildPayload({ ...base, type: 'distributed', framework: 'TF', workers: 3 }, ctx);
  assert.equal(body.spec.distributedFramework, 'TF');
  assert.equal(body.spec.numWorkers, 3);
  assert.equal(body.masterSpecSameAsWorker, true);
});

test('inference: serving port defaults to 8000/http', () => {
  assert.deepEqual(buildPayload({ ...base, type: 'inference' }, ctx).body.spec.servingPort, { container: 8000, protocol: 'http' });
  assert.equal(buildPayload({ ...base, type: 'inference', port: 9000 }, ctx).body.spec.servingPort.container, 9000);
});

test('gpuDemand counts master + workers (not an MPI launcher)', () => {
  assert.equal(gpuDemand({ ...base, gpus: 2 }), 2);
  assert.equal(gpuDemand({ ...base, type: 'distributed', gpus: 2, workers: 3 }), 8);
  assert.equal(gpuDemand({ ...base, type: 'distributed', framework: 'MPI', gpus: 2, workers: 3 }), 6);
  assert.equal(gpuDemand({ ...base, gpus: 0.5 }), 0.5);
});

test('validation catches bad input', () => {
  const bad = (over, re) => assert.match(validateRequest({ ...base, ...over }).join('|'), re);
  bad({ type: 'nope' }, /type must be/);
  bad({ name: 'Bad_Name' }, /name must be/);
  bad({ name: '-x' }, /name must be/);
  bad({ name: 'a'.repeat(64) }, /name must be/);
  bad({ project: '' }, /project is required/);
  bad({ image: '  ' }, /image is required/);
  bad({ gpus: -1 }, /gpus must be/);
  bad({ gpus: 1.5 }, /whole number/);
  bad({ gpus: 99 }, /gpus must be/);
  bad({ cpu: 0 === 1 ? 1 : -2 }, /cpu must be/);
  bad({ memory: '4 gigs' }, /memory must look like/);
  bad({ env: { '1BAD': 'x' } }, /invalid environment variable/);
  bad({ env: [] }, /env must be an object/);
  bad({ type: 'distributed', framework: 'Caffe' }, /framework must be/);
  bad({ type: 'distributed', workers: 0 }, /workers must be/);
  bad({ type: 'inference', port: 70000 }, /port must be/);
  assert.deepEqual(validateRequest(base), []);
  assert.match(validateRequest(null).join(), /JSON object/);
});

test('buildPayload refuses invalid requests with details', () => {
  assert.throws(() => buildPayload({ ...base, name: 'BAD' }, ctx), (e) => Array.isArray(e.validation) && /name/.test(e.message));
});
