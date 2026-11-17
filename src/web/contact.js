// Contact form posted from the landing (coperacha.app) to POST /contact. Validates the
// fields, drops bots (honeypot) and rate-limits per IP. The landing posts with fetch and
// Accept: application/json (a CORS "simple" request, so no preflight); without JavaScript the
// browser posts the form and gets redirected back to the landing.
const EMAIL_RE = /^[^\s@<>()",;:]+@[^\s@<>()",;:]+\.[^\s@<>()",;:]{2,}$/;

export const LIMITS = { name: 100, email: 254, message: 5000 };

const clean = (value) => String(value ?? '').replace(/\r\n?/g, '\n').trim();
const oneLine = (value) => clean(value).replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ');

// Returns { ok: true, value: { name, email, message } } or { ok: false, error } with the copy
// shown to the visitor.
export function validateContact(body = {}) {
  const name = oneLine(body.name);
  const email = oneLine(body.email).toLowerCase();
  const message = clean(body.message).replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, '');
  if (!name) return { ok: false, error: 'Escribe tu nombre.' };
  if (name.length > LIMITS.name) return { ok: false, error: `Tu nombre puede tener hasta ${LIMITS.name} caracteres.` };
  if (!email || email.length > LIMITS.email || !EMAIL_RE.test(email)) return { ok: false, error: 'Escribe un correo válido para poder responderte.' };
  if (message.length < 2) return { ok: false, error: 'Escribe tu mensaje.' };
  if (message.length > LIMITS.message) return { ok: false, error: `Tu mensaje puede tener hasta ${LIMITS.message} caracteres.` };
  return { ok: true, value: { name, email, message } };
}

// Sliding-window limiter: `max` hits per `windowMs` per key, plus a global daily cap so a
// botnet cannot burn the SES quota.
export class RateLimiter {
  constructor({ max = 3, windowMs = 10 * 60_000, dailyMax = 50, clock = () => Date.now() } = {}) {
    Object.assign(this, { max, windowMs, dailyMax, clock });
    this.hits = new Map();
    this.day = [];
  }

  allow(key) {
    const now = this.clock();
    this.day = this.day.filter((t) => now - t < 24 * 3600_000);
    if (this.day.length >= this.dailyMax) return false;
    const recent = (this.hits.get(key) || []).filter((t) => now - t < this.windowMs);
    if (recent.length >= this.max) { this.hits.set(key, recent); return false; }
    recent.push(now);
    this.hits.set(key, recent);
    this.day.push(now);
    if (this.hits.size > 10_000) {
      for (const [k, list] of this.hits) if (!list.some((t) => now - t < this.windowMs)) this.hits.delete(k);
    }
    return true;
  }
}

export function clientIp(req) {
  const forwarded = String(req.headers['x-forwarded-for'] || '').split(',')[0].trim();
  return forwarded || req.socket?.remoteAddress || 'unknown';
}

export function buildContactEmail({ name, email, message }, { to, from }) {
  return {
    from, to, replyTo: email,
    subject: `Contacto desde coperacha.app: ${name}`,
    text: [
      'Nuevo mensaje desde el formulario de contacto de coperacha.app.',
      '',
      `Nombre: ${name}`,
      `Correo: ${email}`,
      '',
      'Mensaje:',
      message,
      '',
      '—',
      'Responde a este correo para contestarle directamente.',
    ].join('\n'),
  };
}
