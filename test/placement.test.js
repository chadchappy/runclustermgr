import { test } from 'node:test';
import assert from 'node:assert/strict';
import { rankClusters, Reservations } from '../server/placement.js';

const cluster = (id, over = {}) => ({
  id, name: id, state: 'Connected', connected: true, pending: 0, running: 0,
  gpu: { total: 16, free: 8, allocated: 8, ready: 16 },
  projects: { team: { id: `p-${id}`, name: 'team', deserved: 4, limit: null } },
  ...over,
});
const gpu = (total, free) => ({ total, free, allocated: total - free, ready: total });
const req = (over = {}) => ({ gpus: 2, project: 'team', ...over });

test('picks the cluster with the most free GPUs', () => {
  const r = rankClusters([cluster('a', { gpu: gpu(16, 4) }), cluster('b', { gpu: gpu(16, 12) }), cluster('c', { gpu: gpu(16, 8) })], req());
  assert.equal(r.chosen, 'b');
  assert.equal(r.queued, false);
  assert.deepEqual(r.ranked.map((x) => x.clusterId), ['b', 'c', 'a']);
  assert.match(r.message, /Placing on b/);
});

test('a small cluster with more FREE GPUs beats a big, busy one', () => {
  const r = rankClusters([cluster('big', { gpu: gpu(256, 3) }), cluster('small', { gpu: gpu(8, 6) })], req());
  assert.equal(r.chosen, 'small');
});

test('disconnected clusters are never chosen', () => {
  const r = rankClusters([cluster('off', { connected: false, state: 'Disconnected', gpu: gpu(64, 64) }), cluster('on', { gpu: gpu(16, 3) })], req());
  assert.equal(r.chosen, 'on');
  const off = r.ranked.find((x) => x.clusterId === 'off');
  assert.equal(off.eligible, false);
  assert.match(off.rejections[0], /not connected/);
});

test('cluster without the requested project is ineligible', () => {
  const r = rankClusters([cluster('a', { projects: {}, gpu: gpu(16, 16) }), cluster('b', { gpu: gpu(16, 2) })], req());
  assert.equal(r.chosen, 'b');
  assert.match(r.ranked.find((x) => x.clusterId === 'a').rejections[0], /project "team" does not exist/);
});

test('project GPU limit is a hard constraint', () => {
  const limited = cluster('a', { gpu: gpu(16, 16), projects: { team: { id: 'p', name: 'team', deserved: 1, limit: 1 } } });
  const r = rankClusters([limited, cluster('b', { gpu: gpu(16, 2) })], req({ gpus: 2 }));
  assert.equal(r.chosen, 'b');
  assert.match(r.ranked.find((x) => x.clusterId === 'a').rejections[0], /exceeds project GPU limit/);
});

test('no cluster fits: queues on the one with the fewest pending (policy queue)', () => {
  const r = rankClusters([cluster('a', { gpu: gpu(16, 1), pending: 5 }), cluster('b', { gpu: gpu(16, 0), pending: 1 })], req({ gpus: 8 }));
  assert.equal(r.chosen, 'b');
  assert.equal(r.queued, true);
  assert.match(r.message, /queueing on b/);
});

test('no cluster fits: policy reject returns no choice', () => {
  const r = rankClusters([cluster('a', { gpu: gpu(16, 1) })], req({ gpus: 8 }), { noFitStrategy: 'reject' });
  assert.equal(r.chosen, null);
  assert.match(r.message, /queueing is disabled/);
});

test('no eligible clusters explains every rejection', () => {
  const r = rankClusters([cluster('a', { connected: false, state: 'Disconnected' }), cluster('b', { projects: {} })], req());
  assert.equal(r.chosen, null);
  assert.match(r.message, /a: cluster is not connected/);
  assert.match(r.message, /b: project "team" does not exist/);
});

test('empty cluster list', () => {
  const r = rankClusters([], req());
  assert.equal(r.chosen, null);
  assert.match(r.message, /no clusters found/);
});

test('unknown capacity is not treated as available (unless policy allows)', () => {
  const unknown = cluster('u', { gpu: { total: null, free: null, allocated: null, ready: null } });
  const known = cluster('k', { gpu: gpu(16, 2) });
  assert.equal(rankClusters([unknown, known], req()).chosen, 'k');
  const only = rankClusters([unknown], req());
  assert.equal(only.queued, true); // cannot verify -> queue, never claim a fit
  assert.equal(rankClusters([unknown], req(), { allowUnknownCapacity: true }).queued, false);
});

test('ties on free GPUs break by fewest pending, then lower allocation, then name', () => {
  const r = rankClusters([cluster('b', { pending: 2 }), cluster('a', { pending: 2 }), cluster('c', { pending: 0 })], req());
  assert.deepEqual(r.ranked.map((x) => x.clusterId), ['c', 'a', 'b']);
});

test('excluded clusters (by name or id) are skipped', () => {
  const r = rankClusters([cluster('a', { gpu: gpu(16, 16) }), cluster('b', { gpu: gpu(16, 1) })], req({ gpus: 1 }), { excludeClusters: ['a'] });
  assert.equal(r.chosen, 'b');
});

test('pinning forces a cluster, even when it must queue', () => {
  const r = rankClusters([cluster('a', { gpu: gpu(16, 16) }), cluster('b', { gpu: gpu(16, 0) })], req({ pinnedClusterId: 'b' }));
  assert.equal(r.chosen, 'b');
  assert.equal(r.queued, true);
});

test('pinning a disconnected cluster fails with a reason', () => {
  const r = rankClusters([cluster('a'), cluster('b', { connected: false, state: 'Disconnected' })], req({ pinnedClusterId: 'b' }));
  assert.equal(r.chosen, null);
});

test('fractional GPU requests fit when at least that fraction is free', () => {
  const r = rankClusters([cluster('a', { gpu: gpu(2, 0.5) })], req({ gpus: 0.5 }));
  assert.equal(r.chosen, 'a');
  assert.equal(r.queued, false);
});

test('CPU-only workloads (0 GPUs) fit anywhere eligible; fewest pending wins', () => {
  const r = rankClusters([cluster('a', { gpu: gpu(16, 0), pending: 3 }), cluster('b', { gpu: gpu(16, 0), pending: 0 })], req({ gpus: 0 }));
  assert.equal(r.chosen, 'b');
  assert.equal(r.queued, false);
});

test('in-flight reservations reduce free GPUs', () => {
  const cs = [cluster('a', { gpu: gpu(16, 10) }), cluster('b', { gpu: gpu(16, 9) })];
  assert.equal(rankClusters(cs, req({ gpus: 2 })).chosen, 'a');
  assert.equal(rankClusters(cs, req({ gpus: 2 }), {}, { a: 4 }).chosen, 'b');
});

test('a burst of submissions spreads across clusters via reservations', () => {
  const cs = [cluster('a', { gpu: gpu(16, 8) }), cluster('b', { gpu: gpu(16, 8) })];
  const res = new Reservations(60000, () => 0);
  const placed = [];
  for (let i = 0; i < 4; i++) {
    const r = rankClusters(cs, req({ gpus: 4 }), {}, res.snapshot());
    placed.push(r.chosen);
    res.add(r.chosen, 4);
  }
  assert.deepEqual(placed.sort(), ['a', 'a', 'b', 'b']);
  // fifth no longer fits anywhere -> queued
  assert.equal(rankClusters(cs, req({ gpus: 4 }), {}, res.snapshot()).queued, true);
});

test('reservations expire and can be released', () => {
  let t = 0;
  const res = new Reservations(1000, () => t);
  res.add('a', 3);
  assert.deepEqual(res.snapshot(), { a: 3 });
  t = 1500;
  assert.deepEqual(res.snapshot(), {});
  res.add('a', 3);
  res.release('a', 3);
  assert.deepEqual(res.snapshot(), {});
  res.add('a', 0); // zero GPU workloads reserve nothing
  assert.deepEqual(res.snapshot(), {});
});
