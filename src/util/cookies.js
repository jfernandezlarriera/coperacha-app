// Signed cookies (HMAC-SHA256). Values are JSON; a bad signature reads as empty.
import crypto from 'node:crypto';

function sign(payload, secret) {
  return crypto.createHmac('sha256', secret).update(payload).digest('base64url');
}

export function encodeSigned(value, secret) {
  const payload = Buffer.from(JSON.stringify(value)).toString('base64url');
  return `${payload}.${sign(payload, secret)}`;
}

export function decodeSigned(cookie, secret) {
  if (!cookie || typeof cookie !== 'string') return null;
  const dot = cookie.lastIndexOf('.');
  if (dot < 0) return null;
  const payload = cookie.slice(0, dot);
  const sig = cookie.slice(dot + 1);
  const expected = sign(payload, secret);
  if (sig.length !== expected.length) return null;
  if (!crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected))) return null;
  try {
    return JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
  } catch {
    return null;
  }
}

export function parseCookies(header) {
  const out = {};
  if (!header) return out;
  for (const part of header.split(';')) {
    const eq = part.indexOf('=');
    if (eq < 0) continue;
    const name = part.slice(0, eq).trim();
    const value = part.slice(eq + 1).trim();
    try { out[name] = decodeURIComponent(value); } catch { out[name] = value; }
  }
  return out;
}

export function serializeCookie(name, value, { secure, maxAge, path = '/', httpOnly = true, sameSite = 'Lax' } = {}) {
  let s = `${name}=${encodeURIComponent(value)}; Path=${path}; SameSite=${sameSite}`;
  if (httpOnly) s += '; HttpOnly';
  if (secure) s += '; Secure';
  if (maxAge !== undefined) s += `; Max-Age=${maxAge}`;
  return s;
}
