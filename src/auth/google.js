// Sign in with Google (OAuth 2.0 authorization code) for organizers, plus a dev stub.
// Tokens are used once to fetch the profile and never stored or logged.
import { newId, randomToken } from '../util/ids.js';

export class GoogleAuth {
  constructor({ clientId, clientSecret, redirectUri, fetchImpl = globalThis.fetch }) {
    this.clientId = clientId;
    this.clientSecret = clientSecret;
    this.redirectUri = redirectUri;
    this.fetch = fetchImpl;
  }

  get enabled() {
    return Boolean(this.clientId && this.clientSecret && this.redirectUri);
  }

  authorizeUrl(state) {
    const params = new URLSearchParams({
      client_id: this.clientId,
      redirect_uri: this.redirectUri,
      response_type: 'code',
      scope: 'openid email profile',
      state,
      prompt: 'select_account',
    });
    return `https://accounts.google.com/o/oauth2/v2/auth?${params}`;
  }

  // Returns {sub, email, name} or throws.
  async exchange(code) {
    const tokenRes = await this.fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        code, client_id: this.clientId, client_secret: this.clientSecret, redirect_uri: this.redirectUri, grant_type: 'authorization_code',
      }),
    });
    if (!tokenRes.ok) throw new Error(`google token exchange failed: ${tokenRes.status}`);
    const tokens = await tokenRes.json();
    const infoRes = await this.fetch('https://openidconnect.googleapis.com/v1/userinfo', {
      headers: { authorization: `Bearer ${tokens.access_token}` },
    });
    if (!infoRes.ok) throw new Error(`google userinfo failed: ${infoRes.status}`);
    const info = await infoRes.json();
    if (!info.sub) throw new Error('google userinfo without sub');
    return { sub: info.sub, email: info.email || '', name: info.name || info.email || 'Organizador' };
  }
}

export function newState() {
  return randomToken(16);
}

// Finds or creates the organizer for a Google profile (or a dev stub profile).
export function upsertOrganizer(store, profile, now = new Date()) {
  const existing = store.findOne('organizers', (o) => o.googleSub === profile.sub);
  if (existing) {
    if (existing.name !== profile.name || existing.email !== profile.email) {
      store.update('organizers', existing.id, { name: profile.name, email: profile.email });
    }
    return store.get('organizers', existing.id);
  }
  return store.insert('organizers', { id: newId(), googleSub: profile.sub, email: profile.email, name: profile.name, createdAt: now.toISOString() });
}
