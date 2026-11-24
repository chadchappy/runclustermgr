// Cluster Manager UI. No dependencies; every piece of server data is rendered
// with textContent (never innerHTML), so API data cannot inject markup.

const $ = (s, el = document) => el.querySelector(s);
const form = $('#form');
const state = { config: null, clusters: [], projects: [], preview: null, pinned: '', lastUpdate: 0, loadError: null, submitting: false };

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
const ago = (ms) => {
  const s = Math.max(0, Math.round((Date.now() - ms) / 1000));
  if (s < 5) return 'just now';
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.round(s / 60)}m ago`;
  if (s < 86400) return `${Math.round(s / 3600)}h ago`;
  return `${Math.round(s / 86400)}d ago`;
};

// ---------- cluster selection ----------
// state.pinned === '' means "Automatic": the most open cluster wins. Otherwise the user's choice.
function setPinned(id) {
  state.pinned = state.pinned === id ? '' : id; // clicking the selected cluster again returns to automatic
  renderPlaceOn();
  renderClusters();
  schedulePreview();
}

function renderPlaceOn() {
  const root = $('#placeOn');
  const auto = state.pinned === '';
  $('#auto').checked = auto;
  $('.placebox').classList.toggle('auto', auto);
  root.replaceChildren(...state.clusters.map((c) =>
    h('button', { type: 'button', role: 'radio', 'aria-checked': String(state.pinned === c.id), disabled: !c.connected, 'data-id': c.id }, c.name)));
  const best = state.preview?.ranked?.find((r) => r.clusterId === state.preview.chosen);
  const chosen = state.clusters.find((c) => c.id === state.pinned);
  $('#autoSub').textContent = auto
    ? (best ? `Runs on the cluster with the most free GPUs (right now: ${best.name})` : 'Runs on the cluster with the most free GPUs')
    : `Off. Running on ${chosen ? chosen.name : 'the cluster you pick'}`;
  $('#placeHint').textContent = auto ? 'Pick a cluster below to choose one yourself.' : 'Turn on Schedule automatically to let the app choose.';
}

// ---------- clusters ----------
function renderClusters() {
  const root = $('#clusters');
  root.replaceChildren();
  const rankById = new Map((state.preview?.ranked || []).map((r, i) => [r.clusterId, { ...r, i }]));
  const best = state.preview?.chosen; // the most open cluster (ignores the manual choice)
  // connected clusters first, then most free GPUs, then name
  const ordered = [...state.clusters].sort((a, b) => (b.connected - a.connected) || ((b.gpu.free ?? -1) - (a.gpu.free ?? -1)) || a.name.localeCompare(b.name));
  for (const c of ordered) {
    const total = c.gpu.total, free = c.gpu.free;
    const used = total && free !== null ? Math.max(0, total - free) : null;
    const rank = rankById.get(c.id);
    const isPinned = state.pinned === c.id;
    const target = state.pinned ? isPinned : best === c.id;
    const dim = rank && !rank.eligible && !isPinned;
    const card = h('article', {
      class: `card${c.connected ? ' pick' : ''}${isPinned ? ' sel' : ''}${!state.pinned && best === c.id ? ' rec' : ''}${dim ? ' dim' : ''}`,
      tabindex: c.connected ? '0' : null,
      role: c.connected ? 'button' : null,
      'aria-pressed': c.connected ? String(isPinned) : null,
      title: c.connected ? (isPinned ? 'Click to schedule automatically again' : `Click to place workloads on ${c.name}`) : null,
    },
      h('div', { class: 'card-head' },
        h('h3', {}, c.name),
        h('span', {},
          isPinned ? h('span', { class: 'pill sel' }, 'Your choice') : null,
          !isPinned && best === c.id ? h('span', { class: state.pinned ? 'pill best' : 'pill rec' }, state.pinned ? 'Most open' : (state.preview?.queued ? 'Queue here' : 'Recommended')) : null,
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
      rank && (target || !rank.eligible) ? h('div', { class: 'why' }, (rank.eligible ? rank.reasons : rank.rejections).slice(0, 3).join(' · ')) : null);
    if (c.connected) {
      card.addEventListener('click', () => setPinned(c.id));
      card.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); setPinned(c.id); } });
    }
    root.append(card);
  }
  const conn = state.clusters.filter((c) => c.connected);
  const free = conn.reduce((a, c) => a + (c.gpu.free || 0), 0);
  const total = conn.reduce((a, c) => a + (c.gpu.total || 0), 0);
  $('#summary').textContent = state.clusters.length ? `${conn.length} of ${state.clusters.length} clusters connected · ${fmt(free)} of ${fmt(total)} GPUs free` : '';
}

// ---------- projects ----------
function renderProjects() {
  const sel = form.elements.project;
  const cur = sel.value;
  sel.replaceChildren(...state.projects.map((p) => h('option', { value: p.name }, p.name)));
  if (state.projects.some((p) => p.name === cur)) sel.value = cur;
  updateProjectHint();
}

function updateProjectHint() {
  const p = state.projects.find((x) => x.name === form.elements.project.value);
  const hint = $('#projHint');
  if (!p) { hint.textContent = ''; return; }
  hint.textContent = `Exists on ${p.clusters.join(', ') || 'no cluster'}.` + (p.missingOn?.length ? ` Created automatically on ${p.missingOn.join(', ')} if the workload runs there.` : '');
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
  if (!forPreview) opt('pinnedClusterId', state.pinned); // the preview always ranks every cluster
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
    const pinned = state.pinned ? p.ranked.find((r) => r.clusterId === state.pinned) : null;
    const best = p.ranked.find((r) => r.clusterId === p.chosen);
    let text; let good = true;
    if (pinned) {
      if (pinned.eligible) {
        text = `Placing on ${pinned.name} (your choice)${pinned.createsProject ? ` — project "${req.project}" will be created there` : ''}.`;
        if (best && best.clusterId !== pinned.clusterId) text += ` Most open right now: ${best.name} (${fmt(best.free)} free).`;
      } else { text = `${pinned.name} cannot be used: ${pinned.rejections.join('; ')}`; good = false; }
    } else { text = p.message; good = !!p.chosen; }
    msg.textContent = text;
    msg.className = `place-msg ${good ? 'good' : 'muted'}`;
    const marked = state.pinned || p.chosen;
    $('#ranking').replaceChildren(...p.ranked.map((r) => h('li', { class: `${r.clusterId === marked && r.eligible ? 'first' : ''}${r.eligible ? '' : ' no'}` },
      h('div', { class: 't' }, h('span', {}, r.name, r.clusterId === state.pinned ? h('small', { class: 'muted' }, ' · your choice') : null),
        r.eligible ? h('span', { class: `pill ${r.fitsNow ? 'ok' : 'warn'}` }, r.fitsNow ? `${fmt(r.free)} free` : 'wait for capacity') : h('span', { class: 'pill bad' }, 'Not eligible')),
      h('div', { class: 'r' }, (r.eligible ? (r.reasons.length ? r.reasons : ['eligible']) : r.rejections).join(' · ')))));
    renderPlaceOn();
    renderClusters();
  } catch (e) {
    if (seq !== previewSeq) return;
    state.preview = null;
    msg.textContent = e.details?.length && typeof e.details[0] === 'string' ? e.details.join(' · ') : e.message;
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
    const chosen = p.ranked?.find((r) => r.clusterId === p.chosen);
    const link = state.config?.controlPlane && !state.config.mock ? h('a', { href: `https://${state.config.controlPlane}/workloads`, target: '_blank', rel: 'noopener' }, 'Open in Run:ai') : null;
    result.className = 'result';
    result.replaceChildren(...[
      h('div', {}, h('b', {}, `Submitted to ${p.chosenName}`), state.pinned ? ' (chosen by you)' : ' (scheduled automatically)', p.queued ? ' — waiting for GPUs (queued)' : ''),
      h('div', { class: 'muted' }, `${req.name} · ${out.workload?.workloadId || ''}`,
        chosen?.createsProject ? ` · created project "${req.project}" on ${p.chosenName}` : '',
        p.attempts?.length ? ` · fell back from ${p.attempts.map((a) => a.clusterName).join(', ')}` : ''),
      link ? h('div', {}, link) : null].filter(Boolean));
    result.hidden = false;
    form.elements.name.value = newName();
    await Promise.all([refresh({ force: true }), loadProjects()]);
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

async function loadProjects() {
  try {
    state.projects = await api('GET', '/api/projects');
    renderProjects();
  } catch { if (!state.projects.length) form.elements.project.replaceChildren(h('option', { value: '' }, 'Projects unavailable')); }
}

async function refresh({ force = false } = {}) {
  try {
    const [c, w] = await Promise.all([api('GET', `/api/clusters${force ? '?refresh=1' : ''}`), api('GET', '/api/workloads').catch(() => null)]);
    state.clusters = c.clusters;
    if (state.pinned && !state.clusters.some((x) => x.id === state.pinned && x.connected)) state.pinned = ''; // chosen cluster went away
    state.lastUpdate = Date.now();
    state.loadError = null;
    $('#alert').hidden = c.errors?.length ? false : true;
    if (c.errors?.length) $('#alert').textContent = `Some Run:ai data is unavailable (shown as —): ${c.errors.join('; ')}`;
    renderPlaceOn();
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
  $('#placeOn').addEventListener('click', (e) => {
    const b = e.target.closest('button');
    if (!b || b.disabled) return;
    state.pinned = b.dataset.id; // choosing a cluster turns automatic scheduling off
    renderPlaceOn(); renderClusters(); schedulePreview();
  });
  $('#auto').addEventListener('change', (e) => {
    if (e.target.checked) state.pinned = '';
    else {
      // switching off: start from the cluster automatic would have used
      const best = state.preview?.chosen;
      const fallback = state.clusters.find((c) => c.connected)?.id || '';
      state.pinned = best || fallback;
    }
    renderPlaceOn(); renderClusters(); schedulePreview();
  });
  form.elements.name.value = newName();
  syncGpuUi(); syncType();

  try {
    state.config = await api('GET', '/api/config');
    $('#mock').hidden = !state.config.mock;
    $('#cp').textContent = state.config.controlPlane ? `Connected to ${state.config.controlPlane}` : 'Multi-cluster scheduling for Run:ai';
    $('#ver').textContent = `v${state.config.version}`;
  } catch { /* shown by refresh */ }

  await loadProjects();
  form.addEventListener('submit', onSubmit);
  form.addEventListener('input', (e) => {
    if (e.target.name === 'gpus') syncGpuUi();
    if (e.target.name === 'type') syncType();
    if (e.target.name === 'project') updateProjectHint();
    schedulePreview();
  });
  $('#refresh').addEventListener('click', () => { refresh({ force: true }); loadProjects(); });

  await refresh();
  runPreview();
  setInterval(() => { if (!document.hidden) refresh(); }, 15000);
  setInterval(() => { if (state.lastUpdate && !state.loadError) $('#liveText').textContent = `Updated ${ago(state.lastUpdate)}`; }, 1000);
  document.addEventListener('visibilitychange', () => { if (!document.hidden) refresh(); });
}

init();
