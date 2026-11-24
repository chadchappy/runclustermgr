// Turns pasted input into a workload request, with syntax and semantic checking.
//
//   parseManifest(text)  a Kubernetes manifest (YAML), the format `runai workload submit -f` takes
//   parseCli(text)       a `runai ... submit ...` command line (CLI 3.x)
//
// Both return { ok, errors:[{line,column,message}], warnings:[string], summary, request }.
// Nothing here executes anything: the CLI text is parsed, never run through a shell.
import * as yaml from './vendor/js-yaml.mjs';
import { readFileSync } from 'node:fs';

export const MAX_TEXT = 256 * 1024;

const err = (message, line = null, column = null) => ({ line, column, message });

// ---------- helpers ----------
function levenshtein(a, b) {
  const m = Array.from({ length: a.length + 1 }, (_, i) => [i]);
  for (let j = 1; j <= b.length; j++) m[0][j] = j;
  for (let i = 1; i <= a.length; i++) for (let j = 1; j <= b.length; j++) m[i][j] = Math.min(m[i - 1][j] + 1, m[i][j - 1] + 1, m[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
  return m[a.length][b.length];
}
export function suggest(word, candidates, max = 3) {
  const w = word.toLowerCase();
  return candidates
    .map((c) => ({ c, d: levenshtein(w, c.toLowerCase()) }))
    .filter((x) => x.d <= Math.max(2, Math.floor(w.length / 3)))
    .sort((a, b) => a.d - b.d)
    .slice(0, max)
    .map((x) => x.c);
}
const didYouMean = (word, cands) => { const s = suggest(word, cands, 2); return s.length ? ` Did you mean ${s.map((x) => `"${x}"`).join(' or ')}?` : ''; };

// ============================================================================================
//  YAML manifest
// ============================================================================================

// Kinds that are valid Kubernetes objects but are not workloads.
const NON_WORKLOAD = new Set(['Namespace', 'Secret', 'ConfigMap', 'Service', 'Ingress', 'PersistentVolume', 'PersistentVolumeClaim',
  'ServiceAccount', 'Role', 'RoleBinding', 'ClusterRole', 'ClusterRoleBinding', 'CustomResourceDefinition', 'NetworkPolicy',
  'StorageClass', 'ResourceQuota', 'LimitRange', 'List']);
const DNS_SUBDOMAIN = /^[a-z0-9]([-a-z0-9.]*[a-z0-9])?$/;

// Line (1-based) of the key at `path` in block-style YAML: matches direct children only, so
// metadata.name is not confused with metadata.labels.name. Falls back to the closest parent, else 1.
export function findKeyLine(text, path) {
  const lines = text.split('\n');
  const keyOf = (l) => /^(\s*)(?:-\s+)?([^\s#:][^:]*?)\s*:(\s|$)/.exec(l);
  const blank = (l) => !l.trim() || l.trim().startsWith('#');
  let from = 0;
  let parentIndent = -1;
  let childIndent = null; // indent of the direct children of the current parent
  let found = 0;
  for (const key of path) {
    let hit = -1;
    for (let i = from; i < lines.length; i++) {
      if (blank(lines[i])) continue;
      const m = keyOf(lines[i]);
      const indent = (/^\s*/.exec(lines[i]) || [''])[0].length;
      if (parentIndent >= 0 && indent <= parentIndent) break; // left the parent block
      if (childIndent === null && parentIndent >= 0) childIndent = indent; // first line inside the parent
      if (!m) continue;
      if (parentIndent >= 0 && indent !== childIndent) continue; // a deeper (nested) key
      if (m[2].replace(/^["']|["']$/g, '') === key) { hit = i; break; }
    }
    if (hit < 0) break;
    found = hit + 1;
    from = hit + 1;
    parentIndent = (/^\s*/.exec(lines[hit]) || [''])[0].length;
    childIndent = null;
  }
  return found || 1;
}

// GPUs the manifest requests: sum over pod specs of nvidia.com/gpu, times replicas/parallelism of the
// object that owns the pod template (Deployment, Job, PyTorchJob replica spec, Ray group ...).
export function detectManifestGpus(doc) {
  let total = 0;
  let any = false;
  const num = (v) => { const n = Number(v); return v !== undefined && v !== null && v !== '' && Number.isFinite(n) && n >= 0 ? n : null; };
  const podGpus = (pod) => {
    let n = 0;
    for (const c of [...(pod.containers || []), ...(pod.initContainers || [])]) {
      const r = c?.resources || {};
      n += Math.max(num(r.limits?.['nvidia.com/gpu']) ?? 0, num(r.requests?.['nvidia.com/gpu']) ?? 0);
    }
    return n;
  };
  const walk = (node, mult) => {
    if (!node || typeof node !== 'object') return;
    if (Array.isArray(node)) { for (const x of node) walk(x, mult); return; }
    if (Array.isArray(node.containers)) { any = true; total += podGpus(node) * mult; return; } // a pod spec
    const owns = node.template && typeof node.template === 'object';
    const copies = owns ? (num(node.replicas) ?? num(node.parallelism) ?? 1) : 1;
    for (const [k, v] of Object.entries(node)) walk(v, k === 'template' ? mult * copies : mult);
  };
  walk(doc, 1);
  return { gpus: any ? total : null };
}

export function parseManifest(text) {
  const errors = [];
  const warnings = [];
  const fail = () => ({ ok: false, errors, warnings, summary: null, request: null });

  if (typeof text !== 'string' || !text.trim()) { errors.push(err('Paste a Kubernetes manifest (YAML).')); return fail(); }
  if (text.length > MAX_TEXT) { errors.push(err(`Manifest is too large (${Math.round(text.length / 1024)} KB, limit ${MAX_TEXT / 1024} KB).`)); return fail(); }

  const docs = [];
  try {
    yaml.loadAll(text, (d) => { if (d !== null && d !== undefined) docs.push(d); });
  } catch (e) {
    if (e instanceof yaml.YAMLException) {
      errors.push(err(`YAML syntax error: ${e.reason}`, (e.mark?.line ?? 0) + 1, (e.mark?.column ?? 0) + 1));
      return fail();
    }
    throw e;
  }

  if (docs.length === 0) { errors.push(err('The YAML is empty (only comments or separators).')); return fail(); }
  if (docs.length > 1) {
    const seps = text.split('\n').map((l, i) => (/^---\s*$/.test(l) ? i + 1 : 0)).filter(Boolean);
    errors.push(err(`Found ${docs.length} documents. Submit one workload at a time: remove the extra documents.`, seps[1] || seps[0] || 1));
    return fail();
  }

  const doc = docs[0];
  if (typeof doc !== 'object' || Array.isArray(doc)) {
    errors.push(err('A manifest must be a YAML mapping (key: value pairs), not a list or a single value.', 1));
    return fail();
  }

  // ---- Kubernetes object shape ----
  if (typeof doc.apiVersion !== 'string' || !doc.apiVersion) errors.push(err('Missing "apiVersion" (for example: apiVersion: batch/v1).', 'apiVersion' in doc ? findKeyLine(text, ['apiVersion']) : 1));
  if (typeof doc.kind !== 'string' || !doc.kind) errors.push(err('Missing "kind" (for example: kind: Job).', 'kind' in doc ? findKeyLine(text, ['kind']) : 1));
  else if (NON_WORKLOAD.has(doc.kind)) errors.push(err(`"${doc.kind}" is not a workload. Submit a workload such as a Job, Deployment, PyTorchJob or a Run:ai workload.`, findKeyLine(text, ['kind'])));
  const md = doc.metadata;
  if (!md || typeof md !== 'object' || Array.isArray(md)) {
    errors.push(err('Missing "metadata" with a "name".', 'metadata' in doc ? findKeyLine(text, ['metadata']) : 1));
  } else {
    if (!md.name && !md.generateName) errors.push(err('"metadata.name" is required (or "metadata.generateName").', findKeyLine(text, ['metadata'])));
    for (const f of ['name', 'generateName']) {
      if (md[f] !== undefined && (typeof md[f] !== 'string' || !DNS_SUBDOMAIN.test(md[f].replace(/-$/, 'x')) || md[f].length > 253)) {
        errors.push(err(`"metadata.${f}" must be lowercase letters, digits, "-" or "." and start and end with a letter or digit.`, findKeyLine(text, ['metadata', f])));
      }
    }
    if (md.namespace) warnings.push(`metadata.namespace "${md.namespace}" is ignored: the workload runs in the selected project's namespace.`);
  }
  if (doc.spec === undefined && !errors.length) warnings.push('The manifest has no "spec"; most workloads need one.');

  if (errors.length) return fail();

  const { gpus } = detectManifestGpus(doc);
  if (gpus === null) warnings.push('Could not find any containers, so the GPUs this needs are unknown. Set "GPUs for placement" yourself.');
  const name = md.name || null;
  return {
    ok: true,
    errors: [],
    warnings,
    summary: { kind: doc.kind, apiVersion: doc.apiVersion, name: name || `${md.generateName}…`, namespace: md.namespace || null, gpus },
    request: { type: 'manifest', name, manifestText: text, gpus: gpus ?? 0, gpusDetected: gpus !== null },
  };
}

// ============================================================================================
//  Run:ai CLI command line
// ============================================================================================

const cliSpec = JSON.parse(readFileSync(new URL('../contract/runai-cli.json', import.meta.url), 'utf8'));
export const CLI_VERSION = cliSpec.generatedFrom;

// command path -> how it maps onto a workload request
const COMMAND_KIND = {
  'workspace submit': { type: 'workspace' },
  'training submit': { type: 'training' },
  'training standard submit': { type: 'training' },
  'training pytorch submit': { type: 'distributed', framework: 'PyTorch' },
  'pytorch submit': { type: 'distributed', framework: 'PyTorch' },
  'training mpi submit': { type: 'distributed', framework: 'MPI' },
  'mpi submit': { type: 'distributed', framework: 'MPI' },
  'inference submit': { type: 'inference' },
  'inference standard submit': { type: 'inference' },
};
const COMMANDS_BY_LENGTH = Object.keys(cliSpec.commands).sort((a, b) => b.split(' ').length - a.split(' ').length);
export const SUPPORTED_COMMANDS = Object.keys(COMMAND_KIND);

// Flags this tool maps onto a workload. Every other flag is a valid CLI flag we refuse to drop silently.
const SUPPORTED_FLAGS = new Set(['--project', '--image', '--gpu-devices-request', '--gpu-portion-request', '--cpu-core-request',
  '--cpu-memory-request', '--environment-variable', '--command', '--name-prefix', '--workers', '--serving-port']);
const IGNORED_GLOBAL = new Set(['--debug', '--quiet', '--verbose']);
const WARN_GLOBAL = new Set(['--config-file', '--config-path']);

function posToLineCol(text, offset) {
  const before = text.slice(0, offset);
  const line = before.split('\n').length;
  return { line, column: offset - (before.lastIndexOf('\n') + 1) + 1 };
}

// Shell-style tokenizer that never expands anything. Returns { tokens:[{value,start}], errors }.
export function tokenize(raw) {
  const errors = [];
  // join backslash-newline continuations while keeping offsets meaningful: replace with a space of equal length
  let text = raw.replace(/\\\r?\n/g, (m) => ' '.repeat(m.length));
  const tokens = [];
  let i = 0;
  let cur = null;
  const push = () => { if (cur) { tokens.push(cur); cur = null; } };
  const bad = (msg, at) => { const p = posToLineCol(raw, at); errors.push(err(msg, p.line, p.column)); };
  // optional shell prompt
  const prompt = /^\s*[$>]\s+/.exec(text);
  if (prompt) i = prompt[0].length;

  while (i < text.length) {
    const ch = text[i];
    if (ch === '\n') {
      push();
      // anything but blanks/comments after a newline would be a second shell command
      const rest = text.slice(i + 1).split('\n').find((l) => l.trim() && !l.trim().startsWith('#'));
      if (rest !== undefined && tokens.length) { bad('Only one command can be submitted at a time. Put additional commands in separate submissions, or end lines with "\\" to continue a command.', i + 1 + text.slice(i + 1).indexOf(rest.trim())); break; }
      i++; continue;
    }
    if (/\s/.test(ch)) { push(); i++; continue; }
    if (ch === '#' && !cur) { while (i < text.length && text[i] !== '\n') i++; continue; }
    if ('|&;<>()'.includes(ch)) {
      bad(`Shell operator "${ch}" is not supported. Submit a single "runai ... submit" command without pipes, redirects or chaining.`, i);
      push(); i++; continue;
    }
    if (ch === '`') { bad('Command substitution (backticks) is not supported.', i); i++; continue; }
    if (ch === '$') {
      const nxt = text[i + 1];
      if (nxt === '(' || nxt === '{' || /[A-Za-z_]/.test(nxt || '')) { bad('Shell variables and substitutions ($...) are not expanded here. Write the literal value instead.', i); i++; continue; }
    }
    if (!cur) cur = { value: '', start: i, quoted: false };
    if (ch === "'") {
      const end = text.indexOf("'", i + 1);
      if (end < 0) { bad('Unterminated single quote (\'). Close the quote or remove it.', i); i = text.length; break; }
      cur.value += text.slice(i + 1, end); cur.quoted = true; i = end + 1; continue;
    }
    if (ch === '"') {
      let j = i + 1; let s = '';
      let closed = false;
      while (j < text.length) {
        const c = text[j];
        if (c === '\\' && j + 1 < text.length && '"\\$`'.includes(text[j + 1])) { s += text[j + 1]; j += 2; continue; }
        if (c === '$' && (text[j + 1] === '(' || text[j + 1] === '{' || /[A-Za-z_]/.test(text[j + 1] || ''))) { bad('Shell variables and substitutions ($...) are not expanded here. Write the literal value instead.', j); }
        if (c === '`') bad('Command substitution (backticks) is not supported.', j);
        if (c === '"') { closed = true; break; }
        s += c; j++;
      }
      if (!closed) { bad('Unterminated double quote ("). Close the quote or remove it.', i); i = text.length; break; }
      cur.value += s; cur.quoted = true; i = j + 1; continue;
    }
    if (ch === '\\' && i + 1 < text.length) { cur.value += text[i + 1]; i += 2; continue; }
    cur.value += ch; i++;
  }
  push();
  return { tokens, errors, text: raw };
}

const shellQuote = (s) => (/^[A-Za-z0-9_@%+=:,./-]+$/.test(s) ? s : `'${s.replace(/'/g, `'\\''`)}'`);

function enumFromDescription(desc) {
  const m = /Valid values?:\s*([A-Za-z0-9_|, -]+?)(?:\.|\s*$|\s{2,})/.exec(desc || '');
  if (!m) return null;
  const raw = m[1].trim();
  if (/[,|-]\s*$/.test(raw) && !/[A-Za-z0-9]$/.test(raw)) return null; // truncated list in help text
  const vals = raw.split(/[,|]/).map((x) => x.trim()).filter(Boolean);
  return vals.length >= 2 ? vals : null;
}

function checkValue(flagName, spec, value) {
  const t = spec.type;
  const n = Number(value);
  if (t === 'int' || t === 'int32' || t === 'positiveInt') {
    if (!/^-?\d+$/.test(value)) return `${flagName} expects a whole number, got "${value}".`;
    if (t === 'positiveInt' && n < 0) return `${flagName} must not be negative.`;
  } else if (t === 'float32' || t === 'positiveFloat') {
    if (value.trim() === '' || !Number.isFinite(n)) return `${flagName} expects a number, got "${value}".`;
    if (t === 'positiveFloat' && n <= 0) return `${flagName} must be greater than 0.`;
  } else if (t === 'duration') {
    if (!/^(\d+(\.\d+)?(ns|us|µs|ms|s|m|h))+$/.test(value)) return `${flagName} expects a duration such as 30s, 5m or 1h30m, got "${value}".`;
  } else if (t !== 'string' && t !== 'stringArray' && t !== 'bool' && t !== 'ints') {
    const allowed = enumFromDescription(spec.description);
    if (allowed && !allowed.includes(value)) return `${flagName} must be one of ${allowed.join(', ')}; got "${value}".`;
  }
  return null;
}

export function parseCli(text, { defaultProject = '' } = {}) {
  const errors = [];
  const warnings = [];
  const fail = () => ({ ok: false, errors, warnings, summary: null, request: null });

  if (typeof text !== 'string' || !text.trim()) { errors.push(err('Enter a runai command, for example: runai workspace submit my-job -p my-project -i ubuntu -g 1')); return fail(); }
  if (text.length > MAX_TEXT) { errors.push(err('Command is too long.')); return fail(); }

  const tk = tokenize(text);
  errors.push(...tk.errors);
  const lc = (tok) => posToLineCol(text, tok.start);
  const tokens = tk.tokens;
  if (!tokens.length) return errors.length ? fail() : (errors.push(err('Enter a runai command.')), fail());

  // ---- program name ----
  if (!/(^|\/)runai$/.test(tokens[0].value)) {
    errors.push(err(`The command must start with "runai", but it starts with "${tokens[0].value}".`, lc(tokens[0]).line, lc(tokens[0]).column));
    return fail();
  }
  if (errors.length) return fail(); // shell syntax problems: report them before interpreting the command

  // ---- find the subcommand (longest match) ----
  const words = [];
  let k = 1;
  while (k < tokens.length && !tokens[k].value.startsWith('-')) { words.push(tokens[k].value); k++; if (words.length >= 3) break; }
  let cmd = null;
  for (const c of COMMANDS_BY_LENGTH) {
    const cw = c.split(' ');
    if (cw.every((w, i) => words[i] === w)) { cmd = c; k = 1 + cw.length; break; }
  }
  if (!cmd) {
    const first = tokens[1];
    const p = first ? lc(first) : { line: 1, column: 1 };
    const topLevel = [...new Set(COMMANDS_BY_LENGTH.map((c) => c.split(' ')[0]))];
    if (first && !topLevel.includes(first.value) && !['version', 'login', 'list', 'describe', 'delete', 'logs'].includes(first.value)) {
      errors.push(err(`Unknown command "runai ${words.join(' ') || first.value}".${didYouMean(first.value, topLevel)} Supported: ${SUPPORTED_COMMANDS.filter((c) => !c.startsWith('training submit') && !c.startsWith('inference submit')).map((c) => `runai ${c}`).join(', ')}.`, p.line, p.column));
    } else {
      errors.push(err(`Only submit commands can be used here (got "runai ${words.join(' ') || first?.value || ''}"). Supported: ${SUPPORTED_COMMANDS.map((c) => `runai ${c}`).join(', ')}.`, p.line, p.column));
    }
    return fail();
  }
  const spec = cliSpec.commands[cmd];
  const kind = COMMAND_KIND[cmd];
  if (cmd === 'workload submit') {
    errors.push(err('"runai workload submit" reads a manifest file from your disk, which this app cannot see. Paste the manifest into the YAML tab instead and choose the project above.', 1, 1));
    return fail();
  }
  if (!kind) {
    errors.push(err(`"runai ${cmd}" is a valid command but is not supported by this portal yet. Supported: ${SUPPORTED_COMMANDS.map((c) => `runai ${c}`).join(', ')}.`, 1, 1));
    return fail();
  }

  // ---- flags ----
  const longs = spec.flags;
  const shortToLong = {};
  for (const [l, f] of Object.entries(longs)) if (f.short) shortToLong[f.short] = l;
  const allLongNames = Object.keys(longs);
  const flags = {}; // long -> value | [values] | true
  const unsupported = [];
  const positional = [];
  let rest = null; // tokens after "--"

  for (; k < tokens.length; k++) {
    const tok = tokens[k];
    const v = tok.value;
    const at = lc(tok);
    if (v === '--' && !tok.quoted) { rest = tokens.slice(k + 1); break; }
    if (!tok.quoted && (v.startsWith('--') || (v.startsWith('-') && v.length > 1 && !/^-\d/.test(v)))) {
      let long; let inline = null;
      if (v.startsWith('--')) {
        const eq = v.indexOf('=');
        long = eq > 0 ? v.slice(0, eq) : v;
        inline = eq > 0 ? v.slice(eq + 1) : null;
      } else {
        const short = v.slice(0, 2);
        long = shortToLong[short];
        const remainder = v.slice(2);
        inline = remainder ? remainder.replace(/^=/, '') : null;
        if (!long) {
          if (short === '-h') { errors.push(err('"-h" asks for help; there is nothing to submit.', at.line, at.column)); continue; }
          if (short === '-d' || short === '-q') continue; // global debug / quiet
          errors.push(err(`Unknown flag "${short}" for "runai ${cmd}".`, at.line, at.column));
          continue;
        }
      }
      if (long === '--help') { errors.push(err('"--help" asks for help; there is nothing to submit.', at.line, at.column)); continue; }
      const def = longs[long];
      if (!def) {
        errors.push(err(`Unknown flag "${long}" for "runai ${cmd}".${didYouMean(long, allLongNames)}`, at.line, at.column));
        const nxt = tokens[k + 1];
        if (inline === null && nxt && (nxt.quoted || !nxt.value.startsWith('-'))) k++; // assume it was the flag's value
        continue;
      }
      if (IGNORED_GLOBAL.has(long)) continue;
      if (WARN_GLOBAL.has(long)) { warnings.push(`${long} is ignored (the app uses its own Run:ai connection).`); if (inline === null) k++; continue; }

      let value;
      if (def.type === 'bool') {
        if (inline !== null) {
          if (!['true', 'false'].includes(inline)) { errors.push(err(`${long} is a switch; use ${long}, ${long}=true or ${long}=false.`, at.line, at.column)); continue; }
          value = inline === 'true';
        } else value = true;
      } else if (inline !== null) value = inline;
      else {
        const nxt = tokens[k + 1];
        if (!nxt || (!nxt.quoted && nxt.value.startsWith('-') && !/^-\d/.test(nxt.value) && nxt.value !== '-')) {
          errors.push(err(`${long} needs a value.`, at.line, at.column));
          continue;
        }
        value = nxt.value; k++;
      }
      if (def.type !== 'bool') {
        const problem = checkValue(long, def, String(value));
        if (problem) { errors.push(err(problem, at.line, at.column)); continue; }
      }
      if (def.type === 'stringArray') (flags[long] ||= []).push(value);
      else {
        if (long in flags) warnings.push(`${long} was given more than once; the last value is used.`);
        flags[long] = value;
      }
      if (!SUPPORTED_FLAGS.has(long) && !IGNORED_GLOBAL.has(long)) unsupported.push({ long, at });
      continue;
    }
    positional.push({ value: v, at });
  }

  for (const u of unsupported) {
    errors.push(err(`${u.long} is a valid runai flag but is not supported by this portal yet, so the workload would run without it. Use the YAML tab for advanced options.`, u.at.line, u.at.column));
  }
  if (positional.length > 1) {
    const p = positional[1];
    errors.push(err(`Unexpected argument "${p.value}". Only the workload name is positional; put container arguments after "--".`, p.at.line, p.at.column));
  }

  // ---- build the request ----
  const req = { type: kind.type };
  if (kind.framework) req.framework = kind.framework;
  const name = positional[0]?.value;
  if (flags['--name-prefix'] !== undefined && name) errors.push(err('Give either a workload name or --name-prefix, not both.', 1, 1));
  if (flags['--name-prefix'] !== undefined) { req.name = flags['--name-prefix']; req.namePrefix = true; }
  else if (name) req.name = name;
  else errors.push(err('Missing workload name. Add it right after the command (runai workspace submit my-job ...) or use --name-prefix.', 1, 1));

  req.project = flags['--project'] || defaultProject || '';
  if (!req.project) errors.push(err('Missing project. Add -p <project>, or choose a project above.', 1, 1));
  else if (!flags['--project'] && defaultProject) warnings.push(`No -p given: using the selected project "${defaultProject}".`);

  if (flags['--image']) req.image = flags['--image'];
  else errors.push(err('Missing image. Add -i <image>.', 1, 1));

  const dev = flags['--gpu-devices-request'];
  const por = flags['--gpu-portion-request'];
  if (por !== undefined) {
    const f = Number(por);
    if (f > 1) errors.push(err('--gpu-portion-request must be between 0 and 1 (use --gpu-devices-request for whole GPUs).', 1, 1));
    if (dev !== undefined && Number(dev) > 1) errors.push(err('--gpu-portion-request cannot be combined with more than one GPU device.', 1, 1));
    req.gpus = f;
  } else req.gpus = dev !== undefined ? Number(dev) : 0;

  if (flags['--cpu-core-request'] !== undefined) req.cpu = Number(flags['--cpu-core-request']);
  if (flags['--cpu-memory-request'] !== undefined) {
    if (!/^\d+(\.\d+)?(M|G|Mi|Gi)$/.test(flags['--cpu-memory-request'])) errors.push(err(`--cpu-memory-request must look like 500M or 4G, got "${flags['--cpu-memory-request']}".`, 1, 1));
    else req.memory = flags['--cpu-memory-request'];
  }

  if (flags['--environment-variable']) {
    req.env = {};
    for (const e of flags['--environment-variable']) {
      const eq = e.indexOf('=');
      if (eq < 1 || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(e.slice(0, eq))) errors.push(err(`Environment variable "${e}" must look like NAME=value.`, 1, 1));
      else req.env[e.slice(0, eq)] = e.slice(eq + 1);
    }
  }

  const tail = (rest || []).map((t) => t.value);
  if (flags['--command']) {
    if (!tail.length) errors.push(err('--command needs the command to run after "--", for example: --command -- python train.py', 1, 1));
    else { req.command = tail[0]; if (tail.length > 1) req.args = tail.slice(1).map(shellQuote).join(' '); }
  } else if (tail.length) req.args = tail.map(shellQuote).join(' ');

  if (kind.type === 'distributed') {
    if (flags['--workers'] !== undefined) {
      const w = Number(flags['--workers']);
      if (w < 1) errors.push(err('--workers must be at least 1.', 1, 1));
      req.workers = w;
    } else { req.workers = 1; warnings.push('--workers not set: assuming 1 worker.'); }
  } else if (flags['--workers'] !== undefined) errors.push(err('--workers only applies to distributed training (pytorch, mpi).', 1, 1));

  if (kind.type === 'inference') {
    const sp = flags['--serving-port'];
    if (sp !== undefined) {
      const simple = /^\d+$/.exec(sp);
      const full = /(?:^|,)container=(\d+)(?:,|$)/.exec(sp);
      if (simple) req.port = Number(sp);
      else if (full && sp.split(',').every((p) => p.startsWith('container='))) req.port = Number(full[1]);
      else errors.push(err('--serving-port options other than the container port are not supported yet. Use --serving-port=PORT.', 1, 1));
    }
  } else if (flags['--serving-port'] !== undefined) errors.push(err('--serving-port only applies to inference.', 1, 1));

  if (errors.length) return fail();

  return {
    ok: true,
    errors: [],
    warnings,
    summary: { command: `runai ${cmd}`, type: req.type, framework: req.framework || null, name: req.name + (req.namePrefix ? '…' : ''), project: req.project, image: req.image, gpus: req.gpus, workers: req.workers ?? null },
    request: req,
  };
}

// ---------- entry used by the server ----------
// body: { source: 'yaml'|'cli', text, project?, gpus? }
export function resolveSource(body) {
  const text = typeof body?.text === 'string' ? body.text : '';
  if (body?.source === 'yaml') {
    const r = parseManifest(text);
    if (r.ok) {
      r.request.project = body.project || '';
      if (!r.request.project) { r.ok = false; r.errors.push(err('Choose a project above: a manifest does not say which Run:ai project to use.')); r.request = null; return r; }
      if (body.gpus !== undefined && body.gpus !== null && body.gpus !== '') {
        const g = Number(body.gpus);
        if (!Number.isFinite(g) || g < 0) { r.ok = false; r.errors.push(err('"GPUs for placement" must be a number of 0 or more.')); r.request = null; return r; }
        r.request.gpus = g; r.request.gpusDetected = false;
      }
    }
    return r;
  }
  if (body?.source === 'cli') return parseCli(text, { defaultProject: body.project || '' });
  return { ok: false, errors: [err('source must be "yaml" or "cli"')], warnings: [], summary: null, request: null };
}

export const formatErrors = (errors) => errors.map((e) => (e.line ? `Line ${e.line}${e.column ? `:${e.column}` : ''}: ${e.message}` : e.message));
