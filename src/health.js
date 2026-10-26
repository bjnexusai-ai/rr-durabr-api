// RR Durbar API: health and admin self-check (plan task 10.8). New file, not wired.
// Same pattern as src/ordering.js: the handler returns null for any path it does not own.
//   GET /api/health            public. Says only whether the API answers and whether ordering is open. No config detail.
//   GET /api/admin/selfcheck   needs header x-admin-key equal to the Worker secret ADMIN_KEY (32+ characters).
//                              Lists bindings, provider modes and the NAMES of missing vars and secrets. Never their values.
const truthy = (v) => /^(1|true|yes|on)$/i.test(String(v ?? '').trim());
const json = (obj, status = 200) => new Response(JSON.stringify(obj), { status, headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' } });

async function sameSecret(a, b) {
  const enc = new TextEncoder();
  const [x, y] = await Promise.all([crypto.subtle.digest('SHA-256', enc.encode(String(a))), crypto.subtle.digest('SHA-256', enc.encode(String(b)))]);
  const u = new Uint8Array(x), v = new Uint8Array(y);
  let d = 0; for (let i = 0; i < u.length; i++) d |= u[i] ^ v[i];
  return d === 0;
}

export function missingConfig(env) {
  const need = ['TOKEN_SIGNING_KEY', 'OTP_HASH_SECRET', 'RISTA_KEY', 'RISTA_SECRET', 'SITE_ORIGIN', 'API_ORIGIN', 'ALLOWED_ORIGINS', 'TERMS_VERSION'];
  const otp = String(env.OTP_PROVIDER || '').toLowerCase(), pay = String(env.PAYMENT_PROVIDER || '').toLowerCase(), loy = String(env.LOYALTY_PROVIDER || '').toLowerCase();
  if (otp === 'msg91') need.push('MSG91_AUTHKEY', 'MSG91_TEMPLATE_ID');
  if (pay === 'payu') need.push('PAYU_KEY', 'PAYU_SALT');
  if (loy === 'reelo') need.push('REELO_DOMAIN', 'REELO_VENDOR_ID');
  const out = need.filter((k) => !env[k]);
  for (const k of ['TOKEN_SIGNING_KEY', 'OTP_HASH_SECRET']) if (env[k] && String(env[k]).length < 32) out.push(`${k} (too short)`);
  return out;
}

export function createHealthHandler({ getDb = (env) => env.DB, getKv = (env) => env.RR_KV } = {}) {
  return async function health(request, env) {
    const url = new URL(request.url);
    if (url.pathname !== '/api/health' && url.pathname !== '/api/admin/selfcheck') return null;
    if (request.method !== 'GET') return json({ error: { code: 'method_not_allowed' } }, 405);
    const ordering = { open: truthy(env.ONLINE_ORDER_LIVE), outlets: String(env.ONLINE_OUTLETS_LIVE || '').split(',').map((s) => s.trim()).filter(Boolean) };
    if (url.pathname === '/api/health') return json({ ok: true, ordering });

    const key = request.headers.get('x-admin-key') || '';
    if (!env.ADMIN_KEY || String(env.ADMIN_KEY).length < 32 || !key || !(await sameSecret(key, env.ADMIN_KEY))) return json({ error: { code: 'not_found' } }, 404);
    const db = getDb(env), kv = getKv(env);
    let dbOk = false;
    try { await db.prepare('SELECT COUNT(*) AS n FROM orders').first(); dbOk = true; } catch { dbOk = false; }
    return json({
      ok: true, ordering,
      bindings: { DB: !!db, DBQuery: dbOk, KV: !!kv },
      providers: { otp: env.OTP_PROVIDER || 'unset', payment: env.PAYMENT_PROVIDER || 'unset', payuMode: env.PAYU_MODE || 'test', loyalty: env.LOYALTY_PROVIDER || 'unset', mocksAllowed: truthy(env.ALLOW_MOCKS) },
      missing: missingConfig(env),
    });
  };
}
