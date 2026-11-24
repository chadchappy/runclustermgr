// Minimal Run:ai REST client (control plane API v1, "client_credentials" auth).
// Zero dependencies: uses Node's built-in fetch. `fetchImpl` is injectable so
// tests and MOCK mode exercise exactly the same code path as production.

export class RunaiError extends Error {
  constructor(message, { status, body, retryable = false } = {}) {
    super(message);
    this.name = 'RunaiError';
    this.status = status;
    this.body = body;
    this.retryable = retryable;
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export class RunaiClient {
  constructor({ baseUrl, clientId, clientSecret, fetchImpl = fetch, timeoutMs = 20000, retries = 2, retryDelayMs = 300 }) {
    this.baseUrl = baseUrl.replace(/\/+$/, '');
    this.clientId = clientId;
    this.clientSecret = clientSecret;
    this.fetch = fetchImpl;
    this.timeoutMs = timeoutMs;
    this.retries = retries;
    this.retryDelayMs = retryDelayMs;
    this.token = null;
    this.tokenExpiresAt = 0;
    this._tokenPromise = null;
  }

  async _raw(method, path, { query, body, headers = {} } = {}) {
    const url = new URL(this.baseUrl + path);
    for (const [k, v] of Object.entries(query || {})) {
      if (v === undefined || v === null) continue;
      if (Array.isArray(v)) v.forEach((x) => url.searchParams.append(k, x));
      else url.searchParams.set(k, String(v));
    }
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), this.timeoutMs);
    try {
      return await this.fetch(url, {
        method,
        headers: { Accept: 'application/json', ...(body ? { 'Content-Type': 'application/json' } : {}), ...headers },
        body: body ? JSON.stringify(body) : undefined,
        signal: ctrl.signal,
      });
    } finally {
      clearTimeout(timer);
    }
  }

  async authenticate() {
    // Coalesce concurrent logins.
    if (this._tokenPromise) return this._tokenPromise;
    this._tokenPromise = (async () => {
      const res = await this._raw('POST', '/api/v1/token', {
        body: { grantType: 'client_credentials', clientID: this.clientId, clientSecret: this.clientSecret },
      });
      const text = await res.text();
      let data = {};
      try { data = text ? JSON.parse(text) : {}; } catch { /* non-JSON */ }
      if (!res.ok || !data.accessToken) {
        throw new RunaiError(
          res.status === 401 || res.status === 403
            ? 'Run:ai rejected the application credentials (check RUNAI_CLIENT_ID / RUNAI_CLIENT_SECRET)'
            : `Run:ai token request failed (HTTP ${res.status})`,
          { status: res.status, body: data },
        );
      }
      this.token = data.accessToken;
      // Refresh 60s early; fall back to 5 min if the server omits expiresIn.
      this.tokenExpiresAt = Date.now() + Math.max(30, (Number(data.expiresIn) || 300) - 60) * 1000;
      return this.token;
    })();
    try {
      return await this._tokenPromise;
    } finally {
      this._tokenPromise = null;
    }
  }

  async _ensureToken() {
    if (!this.token || Date.now() >= this.tokenExpiresAt) await this.authenticate();
    return this.token;
  }

  // method: GET/POST/...; GETs are retried on network errors and 5xx.
  async request(method, path, opts = {}) {
    const idempotent = method === 'GET';
    let attempt = 0;
    let reauthed = false;
    for (;;) {
      try {
        const token = await this._ensureToken();
        const res = await this._raw(method, path, { ...opts, headers: { Authorization: `Bearer ${token}` } });
        if (res.status === 401 && !reauthed) {
          reauthed = true;
          this.token = null;
          continue;
        }
        const text = await res.text();
        let data = null;
        if (text) { try { data = JSON.parse(text); } catch { data = text; } }
        if (res.ok) return data;
        const retryable = res.status >= 500 || res.status === 429;
        if (idempotent && retryable && attempt < this.retries) {
          attempt++;
          await sleep(this.retryDelayMs * 2 ** (attempt - 1));
          continue;
        }
        const first = Array.isArray(data) ? data[0] : data;
        const msg = (first && typeof first === 'object' && (first.message || first.error)) || `HTTP ${res.status}`;
        throw new RunaiError(`Run:ai ${method} ${path} failed: ${msg}`, { status: res.status, body: data, retryable });
      } catch (e) {
        if (e instanceof RunaiError) throw e;
        // network / abort
        if (idempotent && attempt < this.retries) {
          attempt++;
          await sleep(this.retryDelayMs * 2 ** (attempt - 1));
          continue;
        }
        throw new RunaiError(`Run:ai ${method} ${path} unreachable: ${e.message}`, { retryable: true });
      }
    }
  }

  get(path, query) { return this.request('GET', path, { query }); }
  post(path, body) { return this.request('POST', path, { body }); }

  // Follows the API's offset pagination until exhausted (bounded).
  async list(path, key, query = {}, { pageSize = 200, max = 5000 } = {}) {
    const out = [];
    let offset = 0;
    while (out.length < max) {
      const page = await this.get(path, { ...query, limit: pageSize, offset });
      const items = Array.isArray(page) ? page : page?.[key] || [];
      out.push(...items);
      if (items.length < pageSize || (!Array.isArray(page) && !page?.next)) break;
      offset += pageSize;
    }
    return out;
  }
}
