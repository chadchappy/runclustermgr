import { test } from 'node:test';
import assert from 'node:assert/strict';
import { RunaiClient, RunaiError } from '../server/runai-client.js';
import { createMockRunai } from '../server/mock-runai.js';

const mk = (mock, over = {}) => new RunaiClient({ baseUrl: 'http://x', ...mock.credentials, fetchImpl: mock.fetch, retryDelayMs: 1, ...over });

test('authenticates once and reuses the token', async () => {
  const mock = createMockRunai();
  const c = mk(mock);
  await c.get('/api/v1/clusters');
  await c.get('/api/v1/clusters');
  assert.equal(mock.state.tokensIssued, 1);
});

test('sends the client_credentials grant with clientID/clientSecret', async () => {
  let sent;
  const mock = createMockRunai();
  const c = mk(mock, { fetchImpl: (u, init) => { if (new URL(u).pathname === '/api/v1/token') sent = JSON.parse(init.body); return mock.fetch(u, init); } });
  await c.get('/api/v1/clusters');
  assert.deepEqual(sent, { grantType: 'client_credentials', clientID: 'mock-app', clientSecret: 'mock-secret' });
});

test('bad credentials give an actionable error', async () => {
  const mock = createMockRunai();
  const c = mk(mock, { clientSecret: 'wrong' });
  await assert.rejects(c.get('/api/v1/clusters'), (e) => e instanceof RunaiError && e.status === 401 && /RUNAI_CLIENT_SECRET/.test(e.message));
});

test('an expired token is refreshed transparently', async () => {
  const mock = createMockRunai();
  const c = mk(mock);
  await c.get('/api/v1/clusters');
  mock.state.expireTokens = true;
  const out = await c.get('/api/v1/clusters');
  assert.ok(Array.isArray(out));
  assert.equal(mock.state.tokensIssued, 2);
});

test('concurrent first calls share one login', async () => {
  const mock = createMockRunai();
  const c = mk(mock);
  await Promise.all([c.get('/api/v1/clusters'), c.get('/api/v1/clusters'), c.get('/api/v1/clusters')]);
  assert.equal(mock.state.tokensIssued, 1);
});

test('GETs retry on 5xx; POSTs never do', async () => {
  const mock = createMockRunai();
  let gets = 0;
  let posts = 0;
  const flaky = (u, init) => {
    const p = new URL(u).pathname;
    if (p === '/api/v1/clusters') { gets++; if (gets < 3) return Promise.resolve(new Response('{"message":"boom"}', { status: 503 })); }
    if (p === '/api/v1/workloads/trainings') { posts++; return Promise.resolve(new Response('{"message":"boom"}', { status: 503 })); }
    return mock.fetch(u, init);
  };
  const c = mk(mock, { fetchImpl: flaky });
  assert.ok(Array.isArray(await c.get('/api/v1/clusters')));
  assert.equal(gets, 3);
  await assert.rejects(c.post('/api/v1/workloads/trainings', {}), (e) => e.status === 503);
  assert.equal(posts, 1);
});

test('GET gives up after retries with the API message', async () => {
  const mock = createMockRunai();
  const c = mk(mock, { retries: 1, fetchImpl: (u, i) => (new URL(u).pathname === '/api/v1/token' ? mock.fetch(u, i) : Promise.resolve(new Response('{"message":"down"}', { status: 500 }))) });
  await assert.rejects(c.get('/api/v1/clusters'), /down/);
});

test('network errors surface as retryable RunaiError', async () => {
  const mock = createMockRunai();
  const c = mk(mock, { retries: 0, fetchImpl: (u, i) => (new URL(u).pathname === '/api/v1/token' ? mock.fetch(u, i) : Promise.reject(new Error('ECONNREFUSED'))) });
  await assert.rejects(c.get('/api/v1/clusters'), (e) => e.retryable === true && /unreachable/.test(e.message));
});

test('list() follows pagination', async () => {
  const mock = createMockRunai();
  const c = mk(mock);
  const all = await c.list('/api/v1/org-unit/projects', 'projects', {}, { pageSize: 2 });
  assert.equal(all.length, 6); // 3 clusters x 2 projects
  const pages = mock.state.calls.filter((x) => x.includes('/org-unit/projects')).length;
  assert.equal(pages, 3);
});

test('query arrays become repeated params', async () => {
  const mock = createMockRunai();
  const c = mk(mock);
  await c.get('/api/v1/nodes/telemetry', { telemetryType: 'FREE_GPUS', groupBy: ['ClusterId', 'Nodepool'] });
  assert.ok(mock.state.calls.some((x) => x.includes('groupBy=ClusterId&groupBy=Nodepool')));
});

test('an error response that is an ARRAY of errors still surfaces Run:ai\'s own message (live /api/v2 behaviour)', async () => {
  const mock = createMockRunai();
  const arr = (u, i) => (new URL(u).pathname === '/api/v1/token' ? mock.fetch(u, i) : Promise.resolve(new Response(JSON.stringify([{ code: 400, message: 'projectId and clusterId are mutually exclusive, provide only one' }]), { status: 400 })));
  const c = mk(mock, { fetchImpl: arr });
  await assert.rejects(c.post('/api/v2/workloads', {}), /mutually exclusive, provide only one/);
});
