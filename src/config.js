// Loads configuration from the environment (and a local .env file if present).
// Values are read once at startup; nothing here is logged.
import fs from 'node:fs';
import path from 'node:path';

export function loadDotEnv(file = path.resolve(process.cwd(), '.env')) {
  if (!fs.existsSync(file)) return;
  for (const raw of fs.readFileSync(file, 'utf8').split('\n')) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq < 0) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    if (process.env[key] === undefined) process.env[key] = value;
  }
}

function bool(value, fallback) {
  if (value === undefined || value === '') return fallback;
  return ['1', 'true', 'yes', 'on'].includes(String(value).toLowerCase());
}

export function buildConfig(env = process.env) {
  return {
    port: Number(env.PORT || 3000),
    baseUrl: (env.APP_BASE_URL || 'http://localhost:3000').replace(/\/$/, ''),
    sessionSecret: env.SESSION_SECRET || '',
    cookieSecure: bool(env.COOKIE_SECURE, false),
    databasePath: env.DATABASE_PATH || './data/coperacha.json',
    timezone: env.APP_TIMEZONE || 'America/Mexico_City',
    google: {
      clientId: env.GOOGLE_CLIENT_ID || '',
      clientSecret: env.GOOGLE_CLIENT_SECRET || '',
      redirectUri: env.GOOGLE_REDIRECT_URI || '',
    },
    authDevLogin: bool(env.AUTH_DEV_LOGIN, false),
    arturito: {
      phone: env.ARTURITO_PHONE || '',
      sendUrl: env.ARTURITO_SEND_URL || '',
      sendKey: env.ARTURITO_SEND_KEY || '',
      registerUrl: env.ARTURITO_REGISTER_URL || '',
      registerToken: env.ARTURITO_REGISTER_TOKEN || env.ARTURITO_SEND_KEY || '',
      webhookToken: env.ARTURITO_WEBHOOK_TOKEN || '',
      sendLimitPerMinute: Number(env.ARTURITO_SEND_LIMIT_PER_MINUTE || 6),
    },
    pey: {
      mode: env.PEY_MODE || 'mock',
      apiUrl: env.PEY_API_URL || '',
      apiKey: env.PEY_API_KEY || '',
      webhookSecret: env.PEY_WEBHOOK_SECRET || '',
    },
  };
}

export function validateConfig(config) {
  const problems = [];
  if (!config.sessionSecret || config.sessionSecret === 'change-me' || config.sessionSecret.length < 16) {
    problems.push('SESSION_SECRET must be a random string of at least 16 characters');
  }
  if (!config.authDevLogin && !config.google.clientId) {
    problems.push('GOOGLE_CLIENT_ID is required unless AUTH_DEV_LOGIN=true');
  }
  if (config.pey.mode === 'http' && !config.pey.apiUrl) {
    problems.push('PEY_API_URL is required when PEY_MODE=http');
  }
  return problems;
}
