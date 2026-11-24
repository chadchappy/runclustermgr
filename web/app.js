// Cluster Manager UI. No dependencies; every piece of server data is rendered
// with textContent (never innerHTML), so API data cannot inject markup.

const $ = (s, el = document) => el.querySelector(s);
const form = $('#form');
const state = { config: null, clusters: [], projects: [], preview: null, lastUpdate: 0, loadError: null, submitting: false };

function h(tag, attrs, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v === false || v === null || v === undefined) continue;
    if (k === 'class') el.className = v;
    else el.setAttribute(k, v === true ? '' : v);
  }
  for (const k of kids.flat()) if (k !== null && k !== undefined && k !== false) el.append(k.nodeType ? k : document.createTextNode(String(k)));
  return el;
}

async function api(method, path, body) {
  const res = await fetch(path, { method, headers: body ? { 'Content-Type': 'application/json' } : {}, body: body ? JSON.stringify(body) : undefined });
  let data = null;
  try { data = await res.json(); } catch { /* empty */ }
  if (!res.ok) throw Object.assign(new Error(data?.error || `HTTP ${res.status}`), { status: res.status, details: data?.details });
  return data;
}

const fmt = (n) => (n === null || n === undefined ? '—' : Number.isInteger(n) ? String(n) : String(Math.round(n * 100) / 100));
const ago = (ms) => { const s = Math.max(0, Math.round((Date.now() - ms) / 1000)); return s < 5 ? 'just now' : s < 60 ? `${s}s ago` : `${Math.round(s / 60)}m ago`; };

// ---------- clusters ----------
function renderClusters() {
  const root = $('#clusters');
  root.replaceChildren();
  const rankById = new Map((state.preview?.ranked || []).map((r, i) => [r.clusterId, { ...r, i }]));
  const chosen = state.preview?.chosen;
  for (const c of state.clusters) {
    const total = c.gpu.total, free = c.gpu.free;
    const used = total && free !== null ? Math.max(0, total - free) : null;
    const rank = rankById.get(c.id);
    const dim = rank && !rank.eligible;
    const card = h('article', { class: `card${chosen === c.id ? ' rec' : ''}${dim ? ' dim' : ''}` },
      h('div', { class: 'card-head' },
        h('h3', {}, c.name),
        h('span', {},
          chosen === c.id ? h('span', { class: 'pill rec' }, state.preview.queued ? 'Queue here' : 'Recommended') : null,
          ' ',
          h('span', { class: `pill ${c.connected ? 'ok' : 'bad'}` }, c.connected ? 'Connected' : c.state))),
      c.connected
        ? h('div', { class: 'big' }, h('b', {}, fmt(free)), h('span', {}, `free of ${fmt(total)} GPUs`))
        : h('div', { class: 'big' }, h('b', {}, '—'), h('span', {}, `offline · ${fmt(total)} GPUs`)),
      h('div', { class: 'bar', role: 'img', 'aria-label': c.connected ? `${fmt(free)} of ${fmt(total)} GPUs free` : 'cluster offline' },
        c.connected && total ? h('i', { class: 'used', style: `width:${(used / total) * 100}%` }) : null,
        c.connected && total && free !== null ? h('i', { style: `width:${(free / total) * 100}%` }) : null),
      h('div', { class: 'stats' },
        h('span', {}, h('b', {}, fmt(c.running)), ' running'),
        h('span', {}, h('b', {}, fmt(c.pending)), ' pending'),
        c.reserved ? h('span', {}, h('b', {}, fmt(c.reserved)), ' reserved') : null,
        c.version ? h('span', {}, 'v', c.version) : null),
      rank ? h('div', { class: 'why' }, (rank.eligible ? rank.reasons : rank.rejections).slice(0, 2).join(' · ')) : null);
    root.append(card);
  }
  const conn = state.clusters.filter((c) => c.connected);
  const free = conn.reduce((a, c) => a + (c.gpu.free || 0), 0);
  const total = conn.reduce((a, c) => a + (c.gpu.total || 0), 0);
  $('#summary').textContent = state.clusters.length ? `${conn.length} of ${state.clusters.length} clusters connected · ${fmt(free)} of ${fmt(total)} GPUs free` : '';
  // pin selector
  const pin = form.elements.pin;
  const cur = pin.value;
  pin.replaceChildren(h('option', { value: '' }, 'Automatic — most available GPUs (recommended)'),
    ...state.clusters.map((c) => h('option', { value: c.id, disabled: !c.connected }, `${c.name}${c.connected ? '' : ' (not connected)'}`)));
  pin.value = state.clusters.some((c) => c.id === cur) ? cur : '';
}

// ---------- form ----------
function parseEnv(text) {
  const env = {};
  for (const line of text.split('\n')) {
    const t = line.trim();
    if (!t || t.startsWith('#')) continue;
    const i = t.indexOf('=');
    if (i < 1) throw new Error(`Environment line "${t}" must look like KEY=value`);
    env[t.slice(0, i).trim()] = t.slice(i + 1);
  }
  return env;
}

function readRequest({ forPreview = false } = {}) {
  const f = form.elements;
  const type = form.querySelector('input[name=type]:checked').value;
  const req = {
    type,
    name: f.name.value.trim() || (forPreview ? 'preview' : ''),
    project: f.project.value,
    image: f.image.value.trim() || (forPreview ? 'preview' : ''),
    gpus: f.gpus.value === '' ? 0 : Number(f.gpus.value),
  };
  const opt = (k, v) => { if (v !== '' && v !== undefined) req[k] = v; };
  opt('cpu', f.cpu.value === '' ? '' : Number(f.cpu.value));
  opt('memory', f.memory.value.trim());
  opt('command', f.command.value.trim());
  opt('args', f.args.value.trim());
  opt('pinnedClusterId', f.pin.value);
  if (type === 'distributed') { req.framework = f.framework.value; req.workers = Number(f.workers.value); }
  if (type === 'inference') opt('port', f.port.value === '' ? '' : Number(f.port.value));
  const env = parseEnv(f.env.value);
  if (Object.keys(env).length) req.env = env;
  return req;
}

let previewSeq = 0;
let previewTimer;
function schedulePreview() {
  clearTimeout(previewTimer);
  previewTimer = setTimeout(runPreview, 250);
}
async function runPreview() {
  const seq = ++previewSeq;
  const msg = $('#placeMsg');
  let req;
  try { req = readRequest({ forPreview: true }); } catch (e) { msg.textContent = e.message; return; }
  if (!req.project) { msg.textContent = 'Choose a project to see where this would run.'; return; }
  try {
    const p = await api('POST', '/api/placement', req);
    if (seq !== previewSeq) return;
    state.preview = p;
    msg.textContent = p.message;
    msg.className = `place-msg ${p.chosen ? 'good' : 'muted'}`;
    const list = $('#ranking');
    list.replaceChildren(...p.ranked.map((r, i) => h('li', { class: `${r.clusterId === p.chosen ? 'first' : ''}${r.eligible ? '' : ' no'}` },
      h('div', { class: 't' }, h('span', {}, r.name),
        r.eligible ? h('span', { class: `pill ${r.fitsNow ? 'ok' : 'warn'}` }, r.fitsNow ? `${fmt(r.free)} free` : 'wait for capacity') : h('span', { class: 'pill bad' }, 'Not eligible')),
      h('div', { class: 'r' }, (r.eligible ? (r.reasons.length ? r.reasons : ['eligible']) : r.rejections).join(' · ')))));
    renderClusters();
  } catch (e) {
    if (seq !== previewSeq) return;
    state.preview = null;
    msg.textContent = e.details?.length ? e.details.join(' · ') : e.message;
    msg.className = 'place-msg muted';
    $('#ranking').replaceChildren();
    renderClusters();
  }
}

function setGpu(v) {
  form.elements.gpus.value = v;
  syncGpuUi();
  schedulePreview();
}
function syncGpuUi() {
  const v = Number(form.elements.gpus.value);
  for (const b of $('#gpuChips').children) b.setAttribute('aria-pressed', String(Number(b.dataset.v) === v));
  $('#gpuHint').textContent = v > 0 && v < 1 ? `Fractional: ${v * 100}% of one GPU.` : v === 0 ? 'CPU-only workload.' : '';
}

function syncType() {
  const type = form.querySelector('input[name=type]:checked').value;
  $('.dist').hidden = type !== 'distributed';
  $('.inf').hidden = type !== 'inference';
}

function newName() { return `job-${Math.random().toString(36).slice(2, 6)}`; }

async function onSubmit(ev) {
  ev.preventDefault();
  if (state.submitting) return;
  const errs = $('#errors');
  const result = $('#result');
  errs.hidden = true; result.hidden = true;
  let req;
  try { req = readRequest(); } catch (e) { errs.replaceChildren(h('li', {}, e.message)); errs.hidden = false; return; }
  state.submitting = true;
  $('#submit').disabled = true; $('#busy').hidden = false;
  try {
    const out = await api('POST', '/api/workloads', req);
    const p = out.placement;
    const link = state.config?.controlPlane && !state.config.mock ? h('a', { href: `https://${state.config.controlPlane}/workloads`, target: '_blank', rel: 'noopener' }, 'Open in Run:ai') : null;
    result.className = 'result';
    result.replaceChildren(
      h('div', {}, h('b', {}, `Submitted to ${p.chosenName}`), p.queued ? ' — waiting for GPUs (queued)' : ''),
      h('div', { class: 'muted' }, `${req.name} · ${out.workload?.workloadId || ''}`, p.attempts?.length ? ` · fell back from ${p.attempts.map((a) => a.clusterName).join(', ')}` : ''),
      link ? h('div', {}, link) : null);
    result.hidden = false;
    form.elements.name.value = newName();
    await refresh({ force: true });
    runPreview();
  } catch (e) {
    const list = e.details && Array.isArray(e.details) && typeof e.details[0] === 'string' ? e.details : null;
    if (list) { errs.replaceChildren(...list.map((m) => h('li', {}, m))); errs.hidden = false; }
    else {
      result.className = 'result bad';
      result.replaceChildren(h('b', {}, 'Not submitted'), h('div', {}, e.message));
      result.hidden = false;
    }
  } finally {
    state.submitting = false;
    $('#submit').disabled = false; $('#busy').hidden = true;
  }
}

// ---------- workloads table ----------
function renderWorkloads(list) {
  const tb = $('#workloads');
  if (!list.length) { tb.replaceChildren(h('tr', {}, h('td', { colspan: 7, class: 'muted' }, 'No workloads yet.'))); return; }
  const phaseClass = (p) => (/run|compl|succe/i.test(p || '') ? 'ok' : /pend|creat|init/i.test(p || '') ? 'warn' : /fail|error|delet/i.test(p || '') ? 'bad' : 'info');
  tb.replaceChildren(...list.map((w) => h('tr', {},
    h('td', {}, w.name), h('td', {}, w.cluster || '—'), h('td', {}, w.project || '—'), h('td', {}, w.type || '—'),
    h('td', {}, w.phase ? h('span', { class: `pill ${phaseClass(w.phase)}` }, w.phase) : '—'),
    h('td', { class: 'num' }, fmt(w.gpus)),
    h('td', { class: 'muted' }, w.createdAt ? ago(Date.parse(w.createdAt)) : '—'))));
}

// ---------- refresh loop ----------
function setLive(ok, text) {
  const el = $('#live');
  el.className = `live ${ok ? 'ok' : 'bad'}`;
  $('#liveText').textContent = text;
}

async function refresh({ force = false } = {}) {
  try {
    const [c, w] = await Promise.all([api('GET', `/api/clusters${force ? '?refresh=1' : ''}`), api('GET', '/api/workloads').catch(() => null)]);
    state.clusters = c.clusters;
    state.lastUpdate = Date.now();
    state.loadError = null;
    $('#alert').hidden = c.errors?.length ? false : true;
    if (c.errors?.length) $('#alert').textContent = `Some Run:ai data is unavailable (shown as —): ${c.errors.join('; ')}`;
    renderClusters();
    if (w) renderWorkloads(w);
    setLive(true, `Updated ${ago(state.lastUpdate)}`);
  } catch (e) {
    state.loadError = e.message;
    $('#alert').hidden = false;
    $('#alert').textContent = `Could not load clusters: ${e.message}`;
    setLive(false, 'Disconnected');
  }
}

async function init() {
  const chips = $('#gpuChips');
  for (const v of [0, 0.25, 0.5, 1, 2, 4, 8]) {
    chips.append(h('button', { type: 'button', 'data-v': v, 'aria-pressed': 'false' }, v === 0 ? 'None' : String(v)));
  }
  chips.addEventListener('click', (e) => { const b = e.target.closest('button'); if (b) setGpu(Number(b.dataset.v)); });
  form.elements.name.value = newName();
  syncGpuUi(); syncType();

  try {
    state.config = await api('GET', '/api/config');
    $('#mock').hidden = !state.config.mock;
    $('#cp').textContent = state.config.controlPlane ? `Connected to ${state.config.controlPlane}` : 'Multi-cluster scheduling for Run:ai';
    $('#ver').textContent = `v${state.config.version}`;
  } catch { /* shown by refresh */ }

  try {
    state.projects = await api('GET', '/api/projects');
    form.elements.project.replaceChildren(...state.projects.map((p) => h('option', { value: p.name }, `${p.name} · ${p.clusters.length} cluster${p.clusters.length === 1 ? '' : 's'}`)));
  } catch { form.elements.project.replaceChildren(h('option', { value: '' }, 'Projects unavailable')); }

  form.addEventListener('submit', onSubmit);
  form.addEventListener('input', (e) => {
    if (e.target.name === 'gpus') syncGpuUi();
    if (e.target.name === 'type') syncType();
    schedulePreview();
  });
  $('#refresh').addEventListener('click', () => refresh({ force: true }));

  await refresh();
  runPreview();
  setInterval(() => { if (!document.hidden) refresh(); }, 15000);
  setInterval(() => { if (state.lastUpdate && !state.loadError) $('#liveText').textContent = `Updated ${ago(state.lastUpdate)}`; }, 1000);
  document.addEventListener('visibilitychange', () => { if (!document.hidden) refresh(); });
}

init();
