#!/usr/bin/env node
// Renders k8s/clustermgr.yaml from environment variables.
//   IMAGE, RUNAI_CONTROL_PLANE, MOCK            always
//   HOST, INGRESS_CLASS                         when INGRESS=1 (default)
//   TLS_SECRET                                  when set -> adds spec.tls
//   PULL_SECRET                                 when set -> adds imagePullSecrets
import { readFileSync } from 'node:fs';

export function render(template, env) {
  const ingress = env.INGRESS !== '0' && !!env.HOST;
  const flags = { tls: ingress && !!env.TLS_SECRET, pull: !!env.PULL_SECRET, ingressclass: ingress && !!env.INGRESS_CLASS };
  let skipping = false;
  const out = [];
  for (const line of template.split('\n')) {
    if (line.includes('# @ingress-begin')) { skipping = !ingress; continue; }
    if (line.includes('# @ingress-end')) { skipping = false; continue; }
    if (skipping) continue;
    const tag = /# @(tls|pull|ingressclass)\s*$/.exec(line);
    if (tag && !flags[tag[1]]) continue;
    out.push(line.replace(/\s*# @(tls|pull|ingressclass)\s*$/, ''));
  }
  const text = out.join('\n');
  const rendered = text.replace(/\$\{(\w+)\}/g, (_, k) => {
    if (env[k] === undefined) throw new Error(`missing value for ${k}`);
    return env[k];
  });
  return rendered;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const tpl = readFileSync(new URL('../k8s/clustermgr.yaml', import.meta.url), 'utf8');
  process.stdout.write(render(tpl, { MOCK: '0', RUNAI_CONTROL_PLANE: '', ...process.env }));
}
