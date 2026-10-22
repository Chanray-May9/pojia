/**
 * 认证：PBKDF2 口令哈希 + 随机 Bearer Token 会话。
 * 纯 Web 标准（crypto.subtle / TextEncoder），可直接在 Cloudflare Workers 运行。
 * 本地 Node 24 同样具备这些全局对象。
 */

const enc = new TextEncoder();

export const DEFAULT_ITERATIONS = 60000;
export const TOKEN_TTL_DAYS = 30;

export function iterationsFromEnv(env) {
  const n = Number.parseInt(String(env?.PASSWORD_ITERATIONS ?? ''), 10);
  if (!Number.isFinite(n)) return DEFAULT_ITERATIONS;
  return Math.min(Math.max(n, 10000), 600000);
}

export function toHex(buf) {
  const bytes = new Uint8Array(buf);
  let out = '';
  for (const b of bytes) out += b.toString(16).padStart(2, '0');
  return out;
}

export function fromHex(hex) {
  const clean = String(hex || '').replace(/[^0-9a-f]/gi, '');
  const len = Math.floor(clean.length / 2);
  const out = new Uint8Array(len);
  for (let i = 0; i < len; i++) out[i] = Number.parseInt(clean.slice(i * 2, i * 2 + 2), 16);
  return out;
}

export function randomBytes(n = 32) {
  const arr = new Uint8Array(n);
  crypto.getRandomValues(arr);
  return arr;
}

export function base64Url(bytes) {
  let bin = '';
  const arr = new Uint8Array(bytes);
  for (const b of arr) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

export function randomToken(n = 32) {
  return base64Url(randomBytes(n));
}

export async function sha256Hex(text) {
  const digest = await crypto.subtle.digest('SHA-256', enc.encode(String(text)));
  return toHex(digest);
}

export async function hashPassword(password, iterations = DEFAULT_ITERATIONS) {
  const salt = randomBytes(16);
  const key = await crypto.subtle.importKey('raw', enc.encode(password), 'PBKDF2', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', salt, iterations, hash: 'SHA-256' },
    key,
    256
  );
  return `pbkdf2-sha256$${iterations}$${toHex(salt)}$${toHex(bits)}`;
}

function constantTimeEqual(a, b) {
  const x = String(a);
  const y = String(b);
  let diff = x.length ^ y.length;
  const len = Math.max(x.length, y.length);
  for (let i = 0; i < len; i++) {
    diff |= (x.charCodeAt(i) || 0) ^ (y.charCodeAt(i) || 0);
  }
  return diff === 0;
}

export async function verifyPassword(password, stored) {
  try {
    const parts = String(stored || '').split('$');
    if (parts.length !== 4 || parts[0] !== 'pbkdf2-sha256') return false;
    const iterations = Number.parseInt(parts[1], 10);
    const salt = fromHex(parts[2]);
    const expected = parts[3];
    const key = await crypto.subtle.importKey('raw', enc.encode(password), 'PBKDF2', false, ['deriveBits']);
    const bits = await crypto.subtle.deriveBits(
      { name: 'PBKDF2', salt, iterations, hash: 'SHA-256' },
      key,
      256
    );
    return constantTimeEqual(toHex(bits), expected);
  } catch {
    return false;
  }
}

export function newSessionExpiry(days = TOKEN_TTL_DAYS) {
  return new Date(Date.now() + days * 24 * 60 * 60 * 1000).toISOString();
}

/** 从 Authorization: Bearer 中取 token */
export function bearerToken(request) {
  const header = request.headers.get('authorization') || '';
  const m = /^Bearer\s+([A-Za-z0-9_-]{20,200})$/i.exec(header.trim());
  return m ? m[1] : '';
}

export const USERNAME_RE = /^[\p{L}\p{N}_-]{3,20}$/u;
export const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

export function isPlainObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
