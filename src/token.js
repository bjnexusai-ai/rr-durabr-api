// Task 5.x: signed OTP token (HMAC-SHA256). Bound to the phone, carries a nonce that is recorded in D1 (see otp.js claimNonce).
// Needs a secret named TOKEN_SIGNING_KEY (wrangler secret put). Uses Web Crypto only: runs in Workers and Node 18+.
const enc = new TextEncoder();
const b64u = (buf) => btoa(String.fromCharCode(...new Uint8Array(buf))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const unb64u = (s) => Uint8Array.from(atob(s.replace(/-/g, '+').replace(/_/g, '/')), (c) => c.charCodeAt(0));
const key = (secret) => crypto.subtle.importKey('raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign', 'verify']);

export async function signToken(secret, { phone, nonce, ttlSec = 1800, nowMs = Date.now() }) {
  if (!secret || secret.length < 16) throw new Error('token secret too short');
  const body = b64u(enc.encode(JSON.stringify({ p: phone, n: nonce, exp: Math.floor(nowMs / 1000) + ttlSec })));
  const sig = b64u(await crypto.subtle.sign('HMAC', await key(secret), enc.encode(body)));
  return `${body}.${sig}`;
}

export async function verifyToken(secret, token, nowMs = Date.now()) {
  if (typeof token !== 'string' || token.length > 600 || token.split('.').length !== 2) return { ok: false, code: 'token_invalid' };
  const [body, sig] = token.split('.');
  let good = false;
  try { good = await crypto.subtle.verify('HMAC', await key(secret), unb64u(sig), enc.encode(body)); } catch { return { ok: false, code: 'token_invalid' }; }
  if (!good) return { ok: false, code: 'token_invalid' };
  let p;
  try { p = JSON.parse(new TextDecoder().decode(unb64u(body))); } catch { return { ok: false, code: 'token_invalid' }; }
  if (!p || typeof p.exp !== 'number' || p.exp * 1000 < nowMs) return { ok: false, code: 'token_expired' };
  return { ok: true, phone: p.p, nonce: p.n, exp: p.exp };
}
