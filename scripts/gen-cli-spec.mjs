#!/usr/bin/env node
// Generates contract/runai-cli.json from the installed `runai` CLI's own --help output, so the
// CLI syntax checker always matches a real CLI release.
//
//   node scripts/gen-cli-spec.mjs            # uses `runai` from PATH or ~/.runai/bin
//   RUNAI_BIN=/path/to/runai node scripts/gen-cli-spec.mjs
//
// Re-run after upgrading the CLI, then `npm test`.
import { execFileSync } from 'node:child_process';
import { existsSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';

const bin = process.env.RUNAI_BIN || (existsSync(`${homedir()}/.runai/bin/runai`) ? `${homedir()}/.runai/bin/runai` : 'runai');
const run = (args) => execFileSync(bin, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
const strip = (s) => s.replace(/\x1b\[[0-9;]*m/g, '');

// Commands that submit workloads. Each is parsed independently (aliases have their own help).
const COMMANDS = [
  'workspace submit',
  'training submit',
  'training standard submit',
  'training pytorch submit',
  'training mpi submit',
  'pytorch submit',
  'mpi submit',
  'inference submit',
  'inference standard submit',
  'inference distributed submit',
  'inference nim submit',
  'workload submit',
];

const FLAG_RE = /^\s{2,}(?:(-[A-Za-z]),\s+)?(--[A-Za-z0-9][A-Za-z0-9-]*)(?:\s+([A-Za-z0-9_\-[\]]+))?\s{2,}(.*)$/;

function parseHelp(text) {
  const flags = {};
  let section = 'General';
  let inFlags = false;
  let globalSection = false;
  for (const raw of strip(text).split('\n')) {
    if (/^Flags:/.test(raw)) { inFlags = true; globalSection = false; continue; }
    if (/^Global Flags:/.test(raw)) { globalSection = true; continue; }
    if (/^[A-Z][A-Za-z ]+:$/.test(raw) && !/^Flags:|^Global Flags:/.test(raw)) { inFlags = false; continue; }
    if (!inFlags && !globalSection) continue;
    if (/^[A-Za-z][A-Za-z0-9 /&-]*$/.test(raw.trim()) && !raw.startsWith(' ')) { section = raw.trim(); continue; }
    const m = FLAG_RE.exec(raw);
    if (!m) continue;
    const [, short, long, type, desc] = m;
    flags[long] = { short: short || null, type: type || 'bool', description: desc.trim(), group: globalSection ? 'Global' : section };
  }
  return flags;
}

const commands = {};
for (const cmd of COMMANDS) {
  let help;
  try { help = run([...cmd.split(' '), '--help']); } catch (e) { console.error(`skip "${cmd}": ${e.message.split('\n')[0]}`); continue; }
  const flags = parseHelp(help);
  const usage = /^Usage:\s*\n\s+(.+)$/m.exec(strip(help))?.[1]?.trim() || `runai ${cmd} [flags]`;
  commands[cmd] = { usage, flagCount: Object.keys(flags).length, flags };
}

const version = run(['version']).trim().split('\n')[0];
const out = new URL('../contract/runai-cli.json', import.meta.url);
writeFileSync(out, JSON.stringify({ generatedFrom: version, commands }, null, 1) + '\n');
console.log(`wrote contract/runai-cli.json from ${version}`);
for (const [c, v] of Object.entries(commands)) console.log(`  ${c.padEnd(32)} ${v.flagCount} flags`);
