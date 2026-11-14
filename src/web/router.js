// Tiny HTTP router over node:http: path params, body parsing (form/json), cookies, redirects.
import http from 'node:http';
import { parseCookies, serializeCookie } from '../util/cookies.js';
import { log } from '../logger.js';

export class Router {
  constructor() {
    this.routes = [];
  }

  add(method, pattern, handler) {
    const keys = [];
    const regex = new RegExp('^' + pattern.replace(/:([a-zA-Z]+)/g, (_, k) => { keys.push(k); return '([^/]+)'; }) + '/?$');
    this.routes.push({ method, regex, keys, handler });
    return this;
  }

  get(p, h) { return this.add('GET', p, h); }
  post(p, h) { return this.add('POST', p, h); }

  match(method, pathname) {
    for (const r of this.routes) {
      if (r.method !== method) continue;
      const m = r.regex.exec(pathname);
      if (!m) continue;
      const params = {};
      r.keys.forEach((k, i) => { params[k] = decodeURIComponent(m[i + 1]); });
      return { handler: r.handler, params };
    }
    return null;
  }
}

async function readBody(req, limit = 64 * 1024) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) { reject(new Error('body too large')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

function parseBody(raw, contentType = '') {
  if (!raw) return {};
  if (contentType.includes('application/json')) {
    try { return JSON.parse(raw); } catch { return {}; }
  }
  const out = {};
  for (const [k, v] of new URLSearchParams(raw)) out[k] = v;
  return out;
}

export function makeContext(req, res, { secure }) {
  const url = new URL(req.url, 'http://local');
  const cookies = parseCookies(req.headers.cookie);
  const setCookies = [];
  const ctx = {
    req, res, url, query: Object.fromEntries(url.searchParams), cookies, params: {}, body: {}, rawBody: '',
    setCookie(name, value, opts = {}) { setCookies.push(serializeCookie(name, value, { secure, ...opts })); },
    clearCookie(name) { setCookies.push(serializeCookie(name, '', { secure, maxAge: 0 })); },
    send(status, html, headers = {}) {
      res.writeHead(status, { 'content-type': 'text/html; charset=utf-8', 'set-cookie': setCookies, 'x-content-type-options': 'nosniff', 'referrer-policy': 'same-origin', ...headers });
      res.end(html);
    },
    json(status, data) {
      res.writeHead(status, { 'content-type': 'application/json', 'set-cookie': setCookies });
      res.end(JSON.stringify(data));
    },
    redirect(location) {
      res.writeHead(303, { location, 'set-cookie': setCookies });
      res.end();
    },
  };
  return ctx;
}

export function createServer(router, { secure, onError }) {
  return http.createServer(async (req, res) => {
    const ctx = makeContext(req, res, { secure });
    try {
      const matched = router.match(req.method, ctx.url.pathname);
      if (!matched) return ctx.send(404, '<h1>404</h1>');
      ctx.params = matched.params;
      if (req.method === 'POST') {
        ctx.rawBody = await readBody(req);
        ctx.body = parseBody(ctx.rawBody, req.headers['content-type'] || '');
      }
      await matched.handler(ctx);
    } catch (err) {
      if (onError) return onError(ctx, err);
      log.error('http.error', { path: ctx.url.pathname, error: err?.message });
      ctx.send(500, '<h1>Error</h1>');
    }
  });
}
