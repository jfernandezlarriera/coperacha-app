import crypto from 'node:crypto';

export function newId() {
  return crypto.randomUUID();
}

// Short, unguessable, URL-safe code for shareable links (8 chars, 48 bits of entropy).
export function newCode() {
  return crypto.randomBytes(6).toString('base64url');
}

export function randomToken(bytes = 24) {
  return crypto.randomBytes(bytes).toString('base64url');
}
