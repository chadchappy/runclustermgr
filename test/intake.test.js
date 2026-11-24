// YAML manifest and Run:ai CLI input: syntax checking, mapping and end-to-end submission.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { readFileSync } from 'node:fs';
import { parseManifest, parseCli, tokenize, detectManifestGpus, findKeyLine, resolveSource, formatErrors, SUPPORTED_COMMANDS } from '../server/intake.js';
import { RunaiClient } from '../server/runai-client.js';
import { createMockRunai } from '../server/mock-runai.js';
import { ClusterManager } from '../server/service.js';
import { createApp } from '../server/server.js';

const msg = (r) => r.errors.map((e) => e.message).join(' | ');
const at = (r, i = 0) => `${r.errors[i].line}:${r.errors[i].column}`;

// ============================== YAML ==============================
const job = (extra = '') => `apiVersion: batch/v1
kind: Job
metadata:
  name: train-1
spec:
  parallelism: 2
  template:
    spec:
      containers:
      - name: c
        image: busybox
        resources:
          limits:
            nvidia.com/gpu: 2
${extra}`;

test('yaml: a valid Job is accepted and its GPUs are counted over parallelism (2 GPUs x 2 pods)', () => {
  const r = parseManifest(job());
  assert.equal(r.ok, true, msg(r));
  assert.equal(r.summary.kind, 'Job');
  assert.equal(r.summary.name, 'train-1');
  assert.equal(r.summary.gpus, 4);
  assert.equal(r.request.type, 'manifest');
  assert.equal(r.request.gpus, 4);
  assert.equal(r.request.gpusDetected, true);
  assert.equal(r.request.name, 'train-1');
});

test('yaml: GPU detection for Deployment replicas, PyTorchJob roles, bare Pod, requests-only and none', () => {
  const g = (y) => detectManifestGpus(JSON.parse(JSON.stringify(parseYaml(y)))).gpus;
  assert.equal(g('spec:\n  replicas: 3\n  template:\n    spec:\n      containers:\n      - resources: {limits: {nvidia.com/gpu: 1}}'), 3);
  assert.equal(g(`spec:
  pytorchReplicaSpecs:
    Master:
      replicas: 1
      template: {spec: {containers: [{resources: {limits: {nvidia.com/gpu: 1}}}]}}
    Worker:
      replicas: 2
      template: {spec: {containers: [{resources: {limits: {nvidia.com/gpu: 1}}}]}}`), 3);
  assert.equal(g('spec:\n  containers:\n  - resources: {requests: {nvidia.com/gpu: "2"}}'), 2);
  assert.equal(g('spec:\n  containers:\n  - image: x'), 0);
  assert.equal(g('spec:\n  something: else'), null);
});

import * as yamlLib from '../server/vendor/js-yaml.mjs';
const parseYaml = (t) => yamlLib.load(t);

test('yaml: no containers -> GPU need unknown, warned, defaults to 0 and is marked not detected', () => {
  const r = parseManifest('apiVersion: example.com/v1\nkind: Thing\nmetadata:\n  name: t\nspec:\n  x: 1\n');
  assert.equal(r.ok, true);
  assert.equal(r.summary.gpus, null);
  assert.equal(r.request.gpus, 0);
  assert.equal(r.request.gpusDetected, false);
  assert.match(r.warnings.join(' '), /GPUs this needs are unknown/);
});

test('yaml syntax errors carry line and column', () => {
  let r = parseManifest('apiVersion: v1\nkind: Pod\nmetadata:\n  name: x\n spec: 1\n');
  assert.equal(r.ok, false);
  assert.match(msg(r), /bad indentation/);
  assert.equal(at(r), '5:2');

  r = parseManifest('apiVersion: v1\n\tkind: Pod\n');
  assert.match(msg(r), /tab characters/);
  assert.equal(r.errors[0].line, 2);

  r = parseManifest('kind: Pod\nkind: Job\n');
  assert.match(msg(r), /duplicated mapping key/);
  assert.equal(r.errors[0].line, 2);

  r = parseManifest('a: [1, 2\nb: 3\n');
  assert.match(msg(r), /flow collection|bad indentation|end of the stream/);
  assert.ok(r.errors[0].line >= 1);

  r = parseManifest('apiVersion: "v1\nkind: Pod\n');
  assert.match(msg(r), /quoted|stream/);
});

test('yaml: empty input, comments only and oversized input', () => {
  assert.match(msg(parseManifest('')), /Paste a Kubernetes manifest/);
  assert.match(msg(parseManifest('   \n')), /Paste a Kubernetes manifest/);
  assert.match(msg(parseManifest('# nothing here\n---\n')), /empty/);
  assert.match(msg(parseManifest('a: ' + 'x'.repeat(300 * 1024))), /too large/);
  assert.match(msg(parseManifest(null)), /Paste/);
});

test('yaml: more than one document is rejected, pointing at the separator', () => {
  const r = parseManifest(`${job()}---\napiVersion: v1\nkind: Pod\nmetadata:\n  name: p\n`);
  assert.equal(r.ok, false);
  assert.match(msg(r), /Found 2 documents/);
  assert.ok(r.errors[0].line > 10);
});

test('yaml: a single document with a leading --- is fine', () => {
  assert.equal(parseManifest('---\n' + job()).ok, true);
});

test('yaml: top level must be a mapping', () => {
  assert.match(msg(parseManifest('- a\n- b\n')), /must be a YAML mapping/);
  assert.match(msg(parseManifest('just a string')), /must be a YAML mapping/);
});

test('yaml: Kubernetes shape: apiVersion, kind, metadata.name', () => {
  assert.match(msg(parseManifest('kind: Job\nmetadata:\n  name: x\n')), /Missing "apiVersion"/);
  assert.match(msg(parseManifest('apiVersion: v1\nmetadata:\n  name: x\n')), /Missing "kind"/);
  assert.match(msg(parseManifest('apiVersion: v1\nkind: Pod\n')), /Missing "metadata"/);
  const r = parseManifest('apiVersion: v1\nkind: Pod\nmetadata:\n  labels: {a: b}\n');
  assert.match(msg(r), /metadata\.name/);
  assert.equal(r.errors[0].line, 3);
  // generateName is an accepted alternative
  assert.equal(parseManifest('apiVersion: v1\nkind: Pod\nmetadata:\n  generateName: run-\nspec:\n  containers: []\n').ok, true);
});

test('yaml: names are validated and non-workload kinds are refused', () => {
  const bad = parseManifest('apiVersion: v1\nkind: Pod\nmetadata:\n  name: Bad_Name\n');
  assert.match(msg(bad), /lowercase letters/);
  assert.equal(bad.errors[0].line, 4);
  for (const kind of ['Secret', 'ConfigMap', 'Namespace', 'Service', 'PersistentVolumeClaim']) {
    const r = parseManifest(`apiVersion: v1\nkind: ${kind}\nmetadata:\n  name: x\n`);
    assert.match(msg(r), new RegExp(`"${kind}" is not a workload`));
    assert.equal(r.errors[0].line, 2);
  }
});

test('yaml: metadata.namespace is warned about, missing spec is warned about', () => {
  const r = parseManifest('apiVersion: v1\nkind: Pod\nmetadata:\n  name: x\n  namespace: other\n');
  assert.equal(r.ok, true);
  assert.match(r.warnings.join(' '), /namespace "other" is ignored/);
  assert.match(r.warnings.join(' '), /no "spec"/);
});

test('yaml: findKeyLine finds nested keys and falls back to the parent', () => {
  const t = 'apiVersion: v1\nkind: Pod\nmetadata:\n  labels:\n    name: wrong\n  name: right\nspec: {}\n';
  assert.equal(findKeyLine(t, ['kind']), 2);
  assert.equal(findKeyLine(t, ['metadata', 'name']), 6);
  assert.equal(findKeyLine(t, ['metadata', 'nope']), 3);
  assert.equal(findKeyLine(t, ['absent']), 1);
});

test('resolveSource(yaml): project is required; GPU override is validated', () => {
  assert.match(msg(resolveSource({ source: 'yaml', text: job() })), /Choose a project/);
  const ok = resolveSource({ source: 'yaml', text: job(), project: 'team-a' });
  assert.equal(ok.request.project, 'team-a');
  assert.equal(ok.request.gpus, 4);
  const over = resolveSource({ source: 'yaml', text: job(), project: 'team-a', gpus: 1 });
  assert.equal(over.request.gpus, 1);
  assert.equal(over.request.gpusDetected, false);
  assert.match(msg(resolveSource({ source: 'yaml', text: job(), project: 'p', gpus: -2 })), /0 or more/);
  assert.match(msg(resolveSource({ source: 'xml', text: '' })), /source must be/);
});

// ============================== CLI: tokenizer ==============================
test('cli tokenizer: quotes, escapes, comments, prompt and continuation', () => {
  const t = (s) => tokenize(s).tokens.map((x) => x.value);
  assert.deepEqual(t(`runai x "a b" 'c d' e\\ f`), ['runai', 'x', 'a b', 'c d', 'e f']);
  assert.deepEqual(t('$ runai x  y'), ['runai', 'x', 'y']);
  assert.deepEqual(t('runai x # a comment\n'), ['runai', 'x']);
  assert.deepEqual(t('runai x \\\n  y \\\n  z'), ['runai', 'x', 'y', 'z']);
  assert.deepEqual(t(`runai 'it''s' "say \\"hi\\""`), ['runai', 'its', 'say "hi"']);
  assert.deepEqual(t(`runai '$HOME' "\\$HOME" a\\$b`), ['runai', '$HOME', '$HOME', 'a$b']);
});

test('cli tokenizer: unterminated quotes, shell operators and expansions are errors with positions', () => {
  let r = tokenize(`runai x "oops`);
  assert.match(r.errors[0].message, /Unterminated double quote/);
  assert.equal(r.errors[0].column, 9);
  r = tokenize(`runai x 'oops`);
  assert.match(r.errors[0].message, /Unterminated single quote/);
  for (const [text, re] of [['runai x | grep y', /Shell operator "\|"/], ['runai x && runai y', /Shell operator "&"/], ['runai x; ls', /Shell operator ";"/], ['runai x > out', /Shell operator ">"/],
    ['runai x $(date)', /\$\.\.\./], ['runai x ${V}', /\$\.\.\./], ['runai x `date`', /backticks/], ['runai x "a $B"', /\$\.\.\./]]) {
    assert.match(tokenize(text).errors.map((e) => e.message).join(), re, text);
  }
});

test('cli tokenizer: a second command on a new line is an error; trailing blank lines are fine', () => {
  assert.match(msg(parseCli('runai workspace submit a -p p -i u\nrunai workspace submit b -p p -i u')), /Only one command/);
  assert.equal(parseCli('runai workspace submit a -p p -i u\n\n# done\n').ok, true);
});

// ============================== CLI: parsing ==============================
test('cli: workspace with GPU, env, command and arguments', () => {
  const r = parseCli('runai workspace submit my-ws -p team-a -i ubuntu -g 2 -e A=1 -e B=two --cpu-core-request 4 --cpu-memory-request 16G --command -- python -m http.server 8080');
  assert.equal(r.ok, true, msg(r));
  assert.deepEqual(r.request, { type: 'workspace', name: 'my-ws', project: 'team-a', image: 'ubuntu', gpus: 2, cpu: 4, memory: '16G', env: { A: '1', B: 'two' }, command: 'python', args: '-m http.server 8080' });
  assert.equal(r.summary.command, 'runai workspace submit');
});

test('cli: arguments after -- without --command are arguments, not a command; spaces are re-quoted', () => {
  const r = parseCli(`runai training submit job -p p -i u -- --epochs 3 "hello world"`);
  assert.equal(r.ok, true, msg(r));
  assert.equal(r.request.command, undefined);
  assert.equal(r.request.args, `--epochs 3 'hello world'`);
});

test('cli: every supported command maps to the right workload type and framework', () => {
  const t = (c) => parseCli(`runai ${c} n -p p -i u`).request;
  assert.equal(t('workspace submit').type, 'workspace');
  assert.equal(t('training submit').type, 'training');
  assert.equal(t('training standard submit').type, 'training');
  assert.deepEqual([t('training pytorch submit').type, t('training pytorch submit').framework], ['distributed', 'PyTorch']);
  assert.deepEqual([t('pytorch submit').type, t('pytorch submit').framework], ['distributed', 'PyTorch']);
  assert.deepEqual([t('training mpi submit').type, t('mpi submit').framework], ['distributed', 'MPI']);
  assert.equal(t('inference submit').type, 'inference');
  assert.equal(t('inference standard submit').type, 'inference');
});

test('cli: distributed workers (default 1 with a warning), fractional GPU, serving ports', () => {
  let r = parseCli('runai pytorch submit j -p p -i u --workers 4 --gpu-portion-request 0.5');
  assert.deepEqual([r.request.workers, r.request.gpus], [4, 0.5]);
  r = parseCli('runai pytorch submit j -p p -i u');
  assert.equal(r.request.workers, 1);
  assert.match(r.warnings.join(), /--workers not set/);
  assert.equal(parseCli('runai inference submit s -p p -i u --serving-port 9000').request.port, 9000);
  assert.equal(parseCli('runai inference submit s -p p -i u --serving-port=container=7000').request.port, 7000);
  assert.match(msg(parseCli('runai inference submit s -p p -i u --serving-port container=7000,authorization-type=public')), /container port are not supported/);
});

test('cli: flag syntax variants: --flag=value, -pvalue, -p=value, --switch=false', () => {
  const r = parseCli('runai workspace submit w -p=team -i=ubuntu --gpu-devices-request=1');
  assert.equal(r.ok, true, msg(r));
  assert.deepEqual([r.request.project, r.request.image, r.request.gpus], ['team', 'ubuntu', 1]);
  assert.equal(parseCli('runai workspace submit w -pteam -iubuntu').request.project, 'team');
  const off = parseCli('runai workspace submit w -p t -i u --command=false -- ls');
  assert.equal(off.request.command, undefined);
  assert.equal(off.request.args, 'ls');
});

test('cli: --name-prefix, and it excludes a positional name', () => {
  const r = parseCli('runai training submit -p p -i u --name-prefix nightly');
  assert.equal(r.ok, true, msg(r));
  assert.deepEqual([r.request.name, r.request.namePrefix], ['nightly', true]);
  assert.match(msg(parseCli('runai training submit job -p p -i u --name-prefix x')), /either a workload name or --name-prefix/);
});

test('cli: required pieces are reported (name, project, image)', () => {
  const r = parseCli('runai workspace submit');
  assert.match(msg(r), /Missing workload name/);
  assert.match(msg(r), /Missing project/);
  assert.match(msg(r), /Missing image/);
});

test('cli: with no -p the selected project is used and the user is told', () => {
  const r = parseCli('runai workspace submit w -i u', { defaultProject: 'team-b' });
  assert.equal(r.ok, true);
  assert.equal(r.request.project, 'team-b');
  assert.match(r.warnings.join(), /using the selected project "team-b"/);
  assert.equal(parseCli('runai workspace submit w -p mine -i u', { defaultProject: 'team-b' }).request.project, 'mine');
});

test('cli: unknown flags get a suggestion and do not cascade into stray-argument errors', () => {
  const r = parseCli('runai workspace submit w -p t -i u --gpu-device-request 1');
  assert.equal(r.errors.length, 1, msg(r));
  assert.match(msg(r), /Unknown flag "--gpu-device-request".*Did you mean "--gpu-devices-request"/);
  assert.equal(r.errors[0].column, 36);
  assert.match(msg(parseCli('runai workspace submit w -p t -i u -z 1')), /Unknown flag "-z"/);
});

test('cli: valid runai flags this app cannot honour are refused, not silently dropped', () => {
  for (const f of ['--existing-pvc claimname=x', '--template t', '--compute c', '--priority high', '--large-shm', '--node-pools gpu', '--host-path path=/a,mount=/b']) {
    const r = parseCli(`runai workspace submit w -p t -i u ${f}`);
    assert.equal(r.ok, false, f);
    assert.match(msg(r), /valid runai flag but is not supported by this portal yet/, f);
  }
});

test('cli: value type checking uses the CLI own types', () => {
  assert.match(msg(parseCli('runai workspace submit w -p t -i u -g abc')), /expects a whole number/);
  assert.match(msg(parseCli('runai workspace submit w -p t -i u -g -1')), /must not be negative/);
  assert.match(msg(parseCli('runai workspace submit w -p t -i u --gpu-portion-request 0')), /greater than 0/);
  assert.match(msg(parseCli('runai workspace submit w -p t -i u --gpu-portion-request 1.5')), /between 0 and 1/);
  assert.match(msg(parseCli('runai workspace submit w -p t -i u --cpu-core-request many')), /expects a number/);
  assert.match(msg(parseCli('runai workspace submit w -p t -i u --cpu-memory-request 4gigs')), /must look like 500M or 4G/);
  assert.match(msg(parseCli('runai workspace submit w -p t -i u -e NOVALUE')), /must look like NAME=value/);
  assert.match(msg(parseCli('runai workspace submit w -p t -i u --command')), /needs the command to run after "--"/);
  assert.match(msg(parseCli('runai workspace submit w -p t -i u -g')), /needs a value/);
  assert.match(msg(parseCli('runai workspace submit w -p t -i u --attach=maybe')), /is a switch/);
  assert.match(msg(parseCli('runai workspace submit w -p t -i u --workers 2')), /Unknown flag "--workers"/);
  assert.match(msg(parseCli('runai pytorch submit w -p t -i u --workers 0')), /at least 1/);
});

test('cli: wrong program, unknown commands, non-submit commands and the YAML-file command', () => {
  assert.match(msg(parseCli('kubectl get pods')), /must start with "runai"/);
  const unk = parseCli('runai worksapce submit x');
  assert.match(msg(unk), /Unknown command.*Did you mean "workspace"/);
  assert.match(msg(parseCli('runai workspace list')), /Only submit commands/);
  assert.match(msg(parseCli('runai inference distributed submit x -p p -i u')), /valid command but is not supported/);
  assert.match(msg(parseCli('runai workload submit -f job.yaml -p p')), /reads a manifest file from your disk.*YAML tab/);
  assert.match(msg(parseCli('runai workspace submit w -p t -i u --help')), /nothing to submit/);
  assert.match(msg(parseCli('runai workspace submit a b -p t -i u')), /Unexpected argument "b"/);
});

test('cli: global switches are accepted; config flags warn; repeated flags warn', () => {
  const r = parseCli('runai workspace submit w -p t -i u --debug --verbose -q --config-path /tmp -g 1 -g 2');
  assert.equal(r.ok, true, msg(r));
  assert.match(r.warnings.join(), /--config-path is ignored/);
  assert.match(r.warnings.join(), /--gpu-devices-request was given more than once/);
  assert.equal(r.request.gpus, 2);
});

test('cli: empty input and oversize input', () => {
  assert.match(msg(parseCli('')), /Enter a runai command/);
  assert.match(msg(parseCli('  \n')), /Enter a runai command/);
  assert.match(msg(parseCli('runai ' + 'x'.repeat(300 * 1024))), /too long/);
});

test('cli: errors can be formatted as "Line N:C message"', () => {
  assert.deepEqual(formatErrors([{ line: 2, column: 5, message: 'x' }, { line: null, column: null, message: 'y' }]), ['Line 2:5: x', 'y']);
});

// A guard: the generated CLI model must still contain every flag and command this parser maps.
test('cli model (contract/runai-cli.json) contains everything the parser relies on', () => {
  const spec = JSON.parse(readFileSync(new URL('../contract/runai-cli.json', import.meta.url), 'utf8'));
  for (const cmd of SUPPORTED_COMMANDS) assert.ok(spec.commands[cmd], `command "${cmd}" missing from the CLI model`);
  const common = ['--project', '--image', '--gpu-devices-request', '--gpu-portion-request', '--cpu-core-request', '--cpu-memory-request', '--environment-variable', '--command', '--name-prefix'];
  for (const cmd of SUPPORTED_COMMANDS) for (const f of common) assert.ok(spec.commands[cmd].flags[f], `${f} missing for "${cmd}"`);
  for (const cmd of ['training pytorch submit', 'pytorch submit', 'training mpi submit', 'mpi submit']) assert.ok(spec.commands[cmd].flags['--workers']);
  for (const cmd of ['inference submit', 'inference standard submit']) assert.ok(spec.commands[cmd].flags['--serving-port']);
  assert.equal(spec.commands['workspace submit'].flags['--project'].short, '-p');
  assert.equal(spec.commands['workspace submit'].flags['--image'].short, '-i');
  assert.match(spec.generatedFrom, /runai-cli\//);
});

// ============================== HTTP end to end ==============================
const open = new Set();
after(() => { for (const s of open) { s.close(); s.closeAllConnections(); } });

async function start({ autoCreate = false } = {}) {
  const mock = createMockRunai({
    clusters: [
      { uuid: 'c-a', name: 'cluster-a', state: 'Connected', total: 32, allocated: 0 },
      { uuid: 'c-b', name: 'cluster-b', state: 'Connected', total: 2, allocated: 0 },
    ],
    projectsByCluster: { 'c-a': ['team-a'], 'c-b': ['team-a'] },
  });
  const config = { mock: true, controlPlane: 'mock', uiUser: '', uiPassword: '', capacityTtlMs: 0, reservationTtlMs: 60000, policy: { excludeClusters: [], allowUnknownCapacity: false, noFitStrategy: 'queue', autoCreateProjects: autoCreate } };
  const client = new RunaiClient({ baseUrl: 'http://mock', ...mock.credentials, fetchImpl: mock.fetch, retries: 0, retryDelayMs: 1 });
  const manager = new ClusterManager({ client, config });
  const server = createApp({ manager, config });
  open.add(server);
  server.listen(0);
  await once(server, 'listening');
  const base = `http://127.0.0.1:${server.address().port}`;
  const call = async (method, path, body) => {
    const res = await fetch(base + path, { method, headers: { 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
    return { status: res.status, json: await res.json() };
  };
  return { mock, call, manager };
}
const cliText = 'runai training submit nightly -p team-a -i busybox:1.36 -g 1 --command -- sleep 60';

test('http: /api/validate reports OK with a summary, or structured errors with positions', async () => {
  const t = await start();
  let r = await t.call('POST', '/api/validate', { source: 'cli', text: cliText });
  assert.equal(r.status, 200);
  assert.equal(r.json.ok, true);
  assert.equal(r.json.summary.type, 'training');
  assert.equal(r.json.request.gpus, 1);
  assert.equal(r.json.request.manifestText, undefined);

  r = await t.call('POST', '/api/validate', { source: 'cli', text: 'runai training submit n -p team-a -i u --bogus 1' });
  assert.equal(r.json.ok, false);
  assert.match(r.json.errors[0].message, /Unknown flag "--bogus"/);
  assert.equal(r.json.errors[0].line, 1);
  assert.ok(r.json.errors[0].column > 1);

  r = await t.call('POST', '/api/validate', { source: 'yaml', project: 'team-a', text: job() });
  assert.equal(r.json.ok, true);
  assert.equal(r.json.request.gpus, 4);
  assert.equal(r.json.request.manifestText, undefined, 'the manifest text is not echoed back');

  r = await t.call('POST', '/api/validate', { source: 'yaml', project: 'team-a', text: 'apiVersion: v1\nkind: Pod\nmetadata:\n  name: x\n spec: 1\n' });
  assert.equal(r.json.ok, false);
  assert.equal(r.json.errors[0].line, 5);

  assert.equal((await t.call('POST', '/api/validate', { source: 'toml', text: 'x' })).status, 400);
  await t.mock;
});

test('http: submit a manifest: placed on the most open cluster; real v2 payload accepted by the contract-checking mock', async () => {
  const t = await start();
  const r = await t.call('POST', '/api/workloads', { source: 'yaml', project: 'team-a', text: job() });
  assert.equal(r.status, 202, JSON.stringify(r.json));
  assert.equal(r.json.placement.chosenName, 'cluster-a'); // 32 free beats 2
  assert.equal(r.json.workload.workloadId, 'wl-1');
  const w = t.mock.state.workloads[0];
  assert.equal(w.viaManifest, true);
  assert.equal(w.name, 'train-1');
  assert.equal(w.projectName, 'team-a');
  assert.equal(w.allocatedResources.gpu, 4);
  assert.ok(t.mock.state.calls.includes('POST /api/v2/workloads'));
});

test('http: manifest GPU need drives placement and reservations; an override is honoured', async () => {
  const t = await start();
  t.mock.state.clusters[0].allocated = 31; // cluster-a: 1 free, cluster-b: 2 free
  let r = await t.call('POST', '/api/placement', { source: 'yaml', project: 'team-a', text: job() }); // needs 4: nothing fits
  assert.equal(r.json.queued, true);
  r = await t.call('POST', '/api/placement', { source: 'yaml', project: 'team-a', text: job(), gpus: 2 });
  assert.equal(r.json.chosen, 'c-b');
  assert.equal(r.json.demandGpus, 2);
});

test('http: pinning a cluster works for manifests and CLI commands', async () => {
  const t = await start();
  let r = await t.call('POST', '/api/workloads', { source: 'yaml', project: 'team-a', text: job().replace('nvidia.com/gpu: 2', 'nvidia.com/gpu: 0'), pinnedClusterId: 'c-b' });
  assert.equal(r.status, 202, JSON.stringify(r.json));
  assert.equal(r.json.placement.chosenName, 'cluster-b');
  r = await t.call('POST', '/api/workloads', { source: 'cli', text: 'runai workspace submit w1 -p team-a -i busybox:1.36', pinnedClusterId: 'c-b' });
  assert.equal(r.json.placement.chosenName, 'cluster-b');
});

test('http: submit a CLI command: becomes a real training workload (contract-checked payload)', async () => {
  const t = await start();
  const r = await t.call('POST', '/api/workloads', { source: 'cli', text: cliText });
  assert.equal(r.status, 202, JSON.stringify(r.json));
  assert.equal(r.json.placement.chosenName, 'cluster-a');
  assert.equal(r.json.workload.name, 'nightly');
  assert.ok(t.mock.state.calls.includes('POST /api/v1/workloads/trainings'));
});

test('http: every CLI form submits successfully (workspace, training, pytorch, mpi, inference, name-prefix, fractional)', async () => {
  const t = await start();
  const cmds = [
    'runai workspace submit a1 -p team-a -i busybox',
    'runai training standard submit a2 -p team-a -i busybox -g 1 -e X=1',
    'runai training pytorch submit a3 -p team-a -i busybox --workers 2 -g 1',
    'runai mpi submit a4 -p team-a -i busybox --workers 1',
    'runai inference submit a5 -p team-a -i busybox --serving-port 8080',
    'runai training submit -p team-a -i busybox --name-prefix nightly',
    'runai workspace submit a7 -p team-a -i busybox --gpu-portion-request 0.5',
  ];
  for (const text of cmds) {
    const r = await t.call('POST', '/api/workloads', { source: 'cli', text });
    assert.equal(r.status, 202, `${text} -> ${JSON.stringify(r.json)}`);
  }
});

test('http: invalid input is rejected with "Line N" details and nothing is sent to Run:ai', async () => {
  const t = await start();
  const before = t.mock.state.calls.length;
  let r = await t.call('POST', '/api/workloads', { source: 'yaml', project: 'team-a', text: 'apiVersion: v1\nkind: Pod\nmetadata:\n  name: x\n spec: 1\n' });
  assert.equal(r.status, 400);
  assert.match(r.json.error, /manifest has errors/);
  assert.match(r.json.details[0], /^Line 5:2: YAML syntax error/);
  r = await t.call('POST', '/api/workloads', { source: 'cli', text: 'runai workspace submit w -p team-a -i u --existing-pvc x=y' });
  assert.equal(r.status, 400);
  assert.match(r.json.details[0], /^Line 1:\d+: --existing-pvc is a valid runai flag/);
  assert.equal(t.mock.state.calls.length, before, 'no Run:ai call was made');
  assert.equal(t.mock.state.workloads.length, 0);
});

test('http: a manifest with generateName is submitted without a name and Run:ai names it', async () => {
  const t = await start();
  const text = 'apiVersion: batch/v1\nkind: Job\nmetadata:\n  generateName: run-\nspec:\n  template:\n    spec:\n      containers:\n      - name: c\n        image: busybox\n';
  const r = await t.call('POST', '/api/workloads', { source: 'yaml', project: 'team-a', text });
  assert.equal(r.status, 202, JSON.stringify(r.json));
  assert.match(r.json.workload.name, /^workload-/);
});

test('http: with AUTO_CREATE_PROJECTS a manifest placed on a cluster without the project creates it first', async () => {
  const t = await start({ autoCreate: true });
  t.mock.state.projects = t.mock.state.projects.filter((p) => p.clusterId !== 'c-b');
  const r = await t.call('POST', '/api/workloads', { source: 'yaml', project: 'team-a', text: job().replace('nvidia.com/gpu: 2', 'nvidia.com/gpu: 0'), pinnedClusterId: 'c-b' });
  assert.equal(r.status, 202, JSON.stringify(r.json));
  assert.equal(t.mock.state.projectCreates, 1);
});

test('http: the config endpoint advertises the supported CLI commands', async () => {
  const t = await start();
  const { json } = await t.call('GET', '/api/config');
  assert.ok(json.cli.commands.includes('workspace submit'));
  assert.match(json.cli.version, /runai-cli/);
  assert.ok(json.limits.maxTextBytes > 1000);
});
