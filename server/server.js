import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { timingSafeEqual } from 'node:crypto';
import { extname, join, normalize, resolve } from 'node:path';
import { HttpError } from './service.js';

const WEB_ROOT = resolve(new URL('../web', import.meta.url).pathname);
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.json': 'application/json', '.ico': 'image/x-icon' };
const MAX_BODY = 1024 * 1024;

const SECURITY_HEADERS = {
  'Content-Security-Policy': "default-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; frame-ancestors 'none'",
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
  'Referrer-Policy': 'no-referrer',
};

function safeEqual(a, b) {
  const ba = Buffer.from(a);
  const bb = Buffer.from(b);
  return ba.length === bb.length && timingSafeEqual(ba, bb);
}

function checkAuth(req, config) {
  if (!config.uiUser) return true;
  const h = req.headers.authorization || '';
  if (!h.startsWith('Basic ')) return false;
  const [u, ...p] = Buffer.from(h.slice(6), 'base64').toString().split(':');
  return safeEqual(u, config.uiUser) && safeEqual(p.join(':'), config.uiPassword);
}

async function readJson(req) {
  let size = 0;
  const chunks = [];
  for await (const c of req) {
    size += c.length;
    if (size > MAX_BODY) throw new HttpError(413, 'request body too large');
    chunks.push(c);
  }
  if (!chunks.length) return {};
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { throw new HttpError(400, 'request body is not valid JSON'); }
}

function send(res, status, body, headers = {}) {
  const isStr = typeof body === 'string' || Buffer.isBuffer(body);
  res.writeHead(status, { ...SECURITY_HEADERS, ...(isStr ? {} : { 'Content-Type': 'application/json' }), 'Cache-Control': 'no-store', ...headers });
  res.end(isStr ? body : JSON.stringify(body));
}

export function createApp({ manager, config, version = '2.0.3', log = () => {} }) {
  async function api(req, res, url) {
    const { pathname } = url;
    if (req.method === 'GET' && pathname === '/api/config') {
      return send(res, 200, {
        version, mock: config.mock, controlPlane: config.controlPlane || null,
        policy: { noFitStrategy: config.policy.noFitStrategy, excludeClusters: config.policy.excludeClusters },
      });
    }
    if (req.method === 'GET' && pathname === '/api/clusters') {
      return send(res, 200, await manager.clusters({ maxAgeMs: url.searchParams.get('refresh') === '1' ? 0 : undefined }));
    }
    if (req.method === 'GET' && pathname === '/api/projects') return send(res, 200, await manager.projects());
    if (req.method === 'POST' && pathname === '/api/placement') return send(res, 200, await manager.place(await readJson(req)));
    if (req.method === 'POST' && pathname === '/api/workloads') return send(res, 202, await manager.submit(await readJson(req)));
    if (req.method === 'GET' && pathname === '/api/workloads') return send(res, 200, await manager.workloads());
    if (req.method === 'GET' && pathname === '/api/decisions') return send(res, 200, manager.recentDecisions());
    throw new HttpError(404, 'not found');
  }

  async function serveStatic(res, pathname) {
    const rel = pathname === '/' ? '/index.html' : pathname;
    const file = normalize(join(WEB_ROOT, rel));
    if (!file.startsWith(WEB_ROOT)) throw new HttpError(404, 'not found');
    try {
      const data = await readFile(file);
      return send(res, 200, data, { 'Content-Type': MIME[extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-cache' });
    } catch {
      throw new HttpError(404, 'not found');
    }
  }

  return createServer(async (req, res) => {
    const started = Date.now();
    const url = new URL(req.url, 'http://x');
    try {
      if (url.pathname === '/healthz') return send(res, 200, { status: 'ok' });
      if (!checkAuth(req, config)) {
        return send(res, 401, { error: 'authentication required' }, { 'WWW-Authenticate': 'Basic realm="Run:ai Cluster Manager"' });
      }
      if (url.pathname === '/readyz') {
        await manager.client.authenticate().catch((e) => { throw new HttpError(503, `not ready: ${e.message}`); });
        return send(res, 200, { status: 'ready' });
      }
      if (url.pathname.startsWith('/api/')) await api(req, res, url);
      else if (req.method === 'GET') await serveStatic(res, url.pathname);
      else throw new HttpError(405, 'method not allowed');
    } catch (e) {
      const status = e instanceof HttpError ? e.status : e?.status >= 400 && e.status < 600 ? 502 : 500;
      if (status >= 500) log({ event: 'error', path: url.pathname, error: e.message });
      send(res, status, { error: e.message, details: e.details ?? undefined });
    } finally {
      if (url.pathname.startsWith('/api/')) log({ event: 'request', method: req.method, path: url.pathname, status: res.statusCode, ms: Date.now() - started });
    }
  });
}
