import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { render } from '../scripts/render-manifest.js';

const tpl = readFileSync(new URL('../k8s/clustermgr.yaml', import.meta.url), 'utf8');
const base = { IMAGE: 'r/clustermgr:1', RUNAI_CONTROL_PLANE: 'cp.example.com', MOCK: '0' };

test('full environment: ingress, TLS, pull secret, class', () => {
  const y = render(tpl, { ...base, HOST: 'cm.example.com', INGRESS_CLASS: 'nginx', TLS_SECRET: 'tls', PULL_SECRET: 'pull' });
  assert.match(y, /kind: Ingress/);
  assert.match(y, /ingressClassName: nginx/);
  assert.match(y, /secretName: tls/);
  assert.match(y, /imagePullSecrets:\n\s+- name: pull/);
  assert.match(y, /image: r\/clustermgr:1/);
  assert.ok(!/\$\{|@tls|@pull|@ingress/.test(y), 'no unresolved placeholders or markers');
});

test('no TLS, no pull secret, default ingress class', () => {
  const y = render(tpl, { ...base, HOST: 'cm.example.com' });
  assert.match(y, /kind: Ingress/);
  assert.ok(!/tls:/.test(y));
  assert.ok(!/imagePullSecrets/.test(y));
  assert.ok(!/ingressClassName/.test(y));
});

test('INGRESS=0 omits the Ingress entirely (port-forward only)', () => {
  const y = render(tpl, { ...base, INGRESS: '0', HOST: 'cm.example.com', TLS_SECRET: 'tls' });
  assert.ok(!/kind: Ingress/.test(y));
  assert.match(y, /kind: Service/);
  assert.match(y, /kind: Deployment/);
});

test('hardening is always present', () => {
  const y = render(tpl, { ...base, INGRESS: '0' });
  for (const s of ['runAsNonRoot: true', 'readOnlyRootFilesystem: true', 'allowPrivilegeEscalation: false', 'automountServiceAccountToken: false', 'drop: ["ALL"]']) assert.ok(y.includes(s), s);
});

test('a missing required value fails loudly', () => {
  assert.throws(() => render(tpl, { RUNAI_CONTROL_PLANE: '', MOCK: '0', INGRESS: '0' }), /missing value for IMAGE/);
});
