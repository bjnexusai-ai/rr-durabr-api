// Routes for tasks 4.1, 4.3, 4.6, 5.1, 5.2, 7.1, 7.3. They only CALL the modules in rr-api-core (pay, slots, token, otp, payu, orderstate, orderstore).
// Nothing here runs until src/index.js calls the handler (see ROUTES_INTEGRATION.md). Wire format = contract v1 (slotId, statusToken, consent.version, Bearer,
// Idempotency-Key, integer paise), the one the checkout page rr-6b was built and tested against.
// The handler returns null for every path it does not own, so the existing routes (menu, prices, quote, order) are untouched.
import { checkMethod, codMaxPaiseFromEnv, isPaise } from './pay.js';
import { makeSlots, validateSlot } from './slots.js';
import { signToken, verifyToken } from './token.js';
import { issueOtp, verifyOtp, claimNonce, rateCheck, msg91Sender } from './otp.js';
import { buildPayuFields, verifyPayuResponse } from './payu.js';
import { transition, markPaid } from './orderstate.js';
import { createOrder, getOrderStatus, newStatusToken, beginIdempotent, finishIdempotent, sha256hex } from './orderstore.js';

// Slugs are the contract's branch codes. ristaCode is for the Rista push later (Phase 8). Patamatalanka is call-only: never listed here.
export const DEFAULT_OUTLETS = {
  singhnagar: { name: 'Singhnagar', ristaCode: 'SN' },
  moghalrajpuram: { name: 'Moghalrajpuram', ristaCode: 'MR' },
  bhavanipuram: { name: 'Bhavanipuram', ristaCode: 'BH' },
  poranki: { name: 'Poranki', ristaCode: 'PO' },
  autonagar: { name: 'Autonagar', ristaCode: 'AT' },
};
const DEFAULT_HOURS = { open: '11:00', close: '23:30', minPrepMinutes: 30, slotMinutes: 15 }; // ASSUMED, owner to confirm (plan section 9)

const MSG = {
  ordering_closed: 'Online ordering is not open yet. Please call the outlet to order.',
  branch_closed: 'This outlet is not taking online orders right now.',
  slot_invalid: 'That pickup time is no longer available. Please choose another.',
  item_unavailable: 'An item in your cart is no longer available. Please remove it.',
  quote_mismatch: 'Prices have changed. Please review your order.',
  cod_not_allowed: 'Pay at pickup is not available for this order. Please pay online.',
  too_many_open_orders: 'You already have open orders. Please collect them first.',
  rate_limited: 'Too many tries. Please wait a little and try again.',
  otp_wrong: 'That code is not right.',
  otp_expired: 'That code has expired. Please ask for a new one.',
  otp_locked: 'Too many wrong tries. Please ask for a new code.',
  token_invalid: 'Please verify your phone number again.',
  idempotency_conflict: 'This order is already being placed. Please wait a moment.',
  bad_request: 'Something is missing or not valid. Please check and try again.',
  not_found: 'We could not find that order.',
  method_not_allowed: 'Method not allowed.',
  provider_down: 'This is not working right now. Nothing has been charged. Please try again soon.',
  internal: 'Something went wrong. Nothing has been charged. Please try again.',
};

const truthy = (v) => v === true || ['true', '1', 'yes'].includes(String(v ?? '').trim().toLowerCase());
const list = (v) => String(v ?? '').split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);
const PHONE = /^[6-9]\d{9}$/;
const EMAIL = /^[^\s@]{1,64}@[^\s@]{1,190}\.[^\s@]{2,}$/;
const KEY = /^[A-Za-z0-9._-]{16,64}$/;

function flagsOf(env) {
  return { live: truthy(env.ONLINE_ORDER_LIVE), liveBranches: list(env.ONLINE_OUTLETS_LIVE), codLive: truthy(env.COD_LIVE), codBranches: list(env.COD_OUTLETS), mocks: truthy(env.ALLOW_MOCKS) };
}

// Frozen-order JSON so the idempotency hash does not depend on key order in the browser's body.
const norm = (v) => (Array.isArray(v) ? v.map(norm) : v && typeof v === 'object' ? Object.fromEntries(Object.keys(v).sort().map((k) => [k, norm(v[k])])) : v);
const stable = (v) => JSON.stringify(norm(v));

function istLabel(iso) {
  const t = new Date(Date.parse(iso) + 330 * 60000);
  const h = t.getUTCHours(), m = t.getUTCMinutes();
  return `${h % 12 || 12}:${String(m).padStart(2, '0')} ${h >= 12 ? 'pm' : 'am'}`;
}
const rupeesToPaise = (s) => (typeof s === 'string' && /^\d{1,7}\.\d{2}$/.test(s) ? Number(s.replace('.', '')) : null);

export function createOrderingHandler(deps = {}) {
  const now = () => (deps.now ? deps.now() : new Date());
  const getDb = (env) => (deps.getDb ? deps.getDb(env) : env.DB);
  const outletsOf = () => deps.outlets || DEFAULT_OUTLETS;

  function outlet(env, slug) {
    const o = outletsOf()[slug];
    if (!o) return null;
    const f = flagsOf(env);
    return { slug, name: o.name, ristaCode: o.ristaCode, ...DEFAULT_HOURS, ...o,
      live: f.live && f.liveBranches.includes(slug),
      codAllowed: f.codLive && f.codBranches.includes(slug) };
  }

  // ---- response helpers (error shape = contract section 1) ----
  function corsHeaders(env, req) {
    const allowed = String(env.ALLOWED_ORIGINS ?? '').split(',').map((s) => s.trim()).filter(Boolean);
    const o = req.headers.get('Origin');
    const h = { Vary: 'Origin' };
    if (o && allowed.includes(o)) {
      h['Access-Control-Allow-Origin'] = o;
      h['Access-Control-Allow-Methods'] = 'GET, POST, OPTIONS';
      h['Access-Control-Allow-Headers'] = 'Content-Type, Authorization, Idempotency-Key';
      h['Access-Control-Max-Age'] = '86400';
    }
    return h;
  }
  const reply = (env, req, data, status = 200, cache = 'no-store', extra = {}) => new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': cache, 'X-Content-Type-Options': 'nosniff', ...corsHeaders(env, req), ...extra },
  });
  const fail = (env, req, status, code, extra = {}) => {
    const { field, message, retryAfterSeconds, details } = extra;
    const err = { code, message: message || MSG[code] || MSG.internal };
    if (field) err.field = field;
    if (retryAfterSeconds) err.retryAfterSeconds = retryAfterSeconds;
    if (details) err.details = details;
    return reply(env, req, { error: err }, status, 'no-store', retryAfterSeconds ? { 'Retry-After': String(retryAfterSeconds) } : {});
  };

  async function readJson(req) {
    const text = await req.text();
    if (text.length > 20000) return null;
    try { const j = JSON.parse(text); return j && typeof j === 'object' && !Array.isArray(j) ? j : null; } catch { return null; }
  }
  const ipOf = (req) => req.headers.get('CF-Connecting-IP') || '';
  const ipHashOf = (env, req) => sha256hex(`${ipOf(req)}:${env.OTP_HASH_SECRET || ''}`);
  const secretsOk = (env, names) => names.every((n) => typeof env[n] === 'string' && env[n].length >= 32);

  // ---- pieces ----
  async function bearer(env, req) {
    const h = req.headers.get('Authorization') || '';
    const m = /^Bearer (\S+)$/.exec(h);
    if (!m) return { ok: false };
    const v = await verifyToken(env.TOKEN_SIGNING_KEY, m[1], now().getTime());
    return v.ok ? { ok: true, phone: v.phone, nonce: v.nonce } : { ok: false };
  }

  async function turnstileOk(env, req, token) {
    if (deps.verifyTurnstile) return deps.verifyTurnstile(env, token, ipOf(req));
    const body = new URLSearchParams({ secret: env.TURNSTILE_SECRET, response: token });
    if (ipOf(req)) body.set('remoteip', ipOf(req));
    const r = await fetch('https://challenges.cloudflare.com/turnstile/v0/siteverify', { method: 'POST', body });
    const j = await r.json();
    return j && j.success === true;
  }

  function senderOf(env, f) {
    if (deps.makeSender) return deps.makeSender(env);
    if (String(env.OTP_PROVIDER || '').toLowerCase() === 'mock') {
      if (!f.mocks) return null; // mocks need ALLOW_MOCKS=true (staging only)
      return { async send(phone, code) { console.log('[mock-otp]', `${phone.slice(0, 2)}xxxxxx${phone.slice(-2)}`, code); return { ok: true, mock: true }; } };
    }
    return msg91Sender(); // throws "not_documented" until DLT template and MSG91 docs are checked (plan 5.1): becomes provider_down
  }

  // ---- GET /api/config ----
  function routeConfig(env, req) {
    const f = flagsOf(env);
    const branches = Object.keys(outletsOf()).map((slug) => {
      const o = outlet(env, slug);
      return { code: slug, name: o.name, open: o.live, codAllowed: o.live && o.codAllowed, hours: { open: o.open, close: o.close }, minPrepMinutes: o.minPrepMinutes };
    });
    return reply(env, req, { orderingOpen: f.live, termsVersion: env.TERMS_VERSION || null, codMaxPaise: codMaxPaiseFromEnv(env), branches }, 200, 'public, max-age=30');
  }

  // ---- GET /api/slots?branch= ----
  function routeSlots(env, req, url) {
    const branch = (url.searchParams.get('branch') || '').toLowerCase();
    const o = outlet(env, branch);
    if (!o) return fail(env, req, 400, 'bad_request', { field: 'branch' });
    if (!o.live) return fail(env, req, 409, 'branch_closed');
    const r = makeSlots({ now: now(), open: o.open, close: o.close, minPrepMinutes: o.minPrepMinutes, slotMinutes: o.slotMinutes });
    return reply(env, req, r.outletClosed ? { slots: [], outletClosed: true } : { slots: r.slots });
  }

  // ---- POST /api/otp/send ----
  async function routeOtpSend(env, req, db) {
    const f = flagsOf(env);
    const b = await readJson(req);
    if (!b || typeof b.phone !== 'string' || !PHONE.test(b.phone)) return fail(env, req, 400, 'bad_request', { field: 'phone', message: 'Please enter a valid 10-digit mobile number.' });
    if (!secretsOk(env, ['OTP_HASH_SECRET'])) return fail(env, req, 503, 'provider_down');
    // Turnstile: required at launch (plan 5.1). Fail closed if it is not configured, unless mocks are explicitly allowed (staging).
    if (env.TURNSTILE_SECRET || deps.verifyTurnstile) {
      if (typeof b.turnstileToken !== 'string' || !b.turnstileToken) return fail(env, req, 400, 'bad_request', { field: 'turnstileToken', message: 'Please complete the check and try again.' });
      let ok = false;
      try { ok = await turnstileOk(env, req, b.turnstileToken); } catch { return fail(env, req, 503, 'provider_down'); }
      if (!ok) return fail(env, req, 400, 'bad_request', { field: 'turnstileToken', message: 'The check did not pass. Please try again.' });
    } else if (!f.mocks) {
      return fail(env, req, 503, 'provider_down');
    }
    const sender = senderOf(env, f);
    if (!sender) return fail(env, req, 503, 'provider_down');
    const r = await issueOtp(db, { phone: b.phone, secret: env.OTP_HASH_SECRET, sender, ipHash: await ipHashOf(env, req), now: now() });
    if (r.ok) return reply(env, req, { sent: true, resendAfterSeconds: r.resendAfterSeconds });
    if (r.code === 'rate_limited') return fail(env, req, 429, 'rate_limited', { retryAfterSeconds: r.retryAfterSeconds });
    if (r.code === 'bad_phone') return fail(env, req, 400, 'bad_request', { field: 'phone' });
    return fail(env, req, 503, 'provider_down');
  }

  // ---- POST /api/otp/verify ----
  async function routeOtpVerify(env, req, db) {
    const b = await readJson(req);
    if (!b || typeof b.phone !== 'string' || typeof b.code !== 'string') return fail(env, req, 400, 'bad_request');
    if (!secretsOk(env, ['OTP_HASH_SECRET', 'TOKEN_SIGNING_KEY'])) return fail(env, req, 503, 'provider_down');
    const r = await verifyOtp(db, { phone: b.phone, code: b.code, secret: env.OTP_HASH_SECRET, now: now() });
    if (!r.ok) {
      if (r.code === 'otp_wrong') return fail(env, req, 400, 'otp_wrong', { message: r.attemptsLeft > 0 ? `That code is not right. ${r.attemptsLeft} ${r.attemptsLeft === 1 ? 'try' : 'tries'} left.` : MSG.otp_wrong });
      if (r.code === 'otp_locked') return fail(env, req, 429, 'otp_locked');
      return fail(env, req, 400, 'otp_expired');
    }
    const token = await signToken(env.TOKEN_SIGNING_KEY, { phone: b.phone, nonce: r.nonce, ttlSec: r.expiresInSeconds, nowMs: now().getTime() });
    return reply(env, req, { token, expiresInSeconds: r.expiresInSeconds });
  }

  // ---- POST /api/loyalty/lookup ----
  async function routeLoyalty(env, req) {
    if (!secretsOk(env, ['TOKEN_SIGNING_KEY'])) return fail(env, req, 503, 'provider_down');
    const who = await bearer(env, req);
    if (!who.ok) return fail(env, req, 401, 'token_invalid');
    const b = await readJson(req);
    const branch = b && typeof b.branch === 'string' ? b.branch.toLowerCase() : '';
    if (!outlet(env, branch)) return fail(env, req, 400, 'bad_request', { field: 'branch' });
    // Reelo is optional: any failure becomes available:false and never blocks checkout (plan 6.2). Balance only, no member flag (Reelo has none).
    if (!deps.loyaltyLookup) return reply(env, req, { available: false });
    try {
      const r = await Promise.race([deps.loyaltyLookup(env, { phone: who.phone, branch }), new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), 8000))]);
      if (!r || r.available !== true) return reply(env, req, { available: false });
      return reply(env, req, { available: true, member: r.member ?? null, balance: Number.isInteger(r.balance) ? r.balance : 0, earnPoints: Number.isInteger(r.earnPoints) ? r.earnPoints : 0, rewardsCount: Number.isInteger(r.rewardsCount) ? r.rewardsCount : 0 });
    } catch { return reply(env, req, { available: false }); }
  }

  // ---- POST /api/checkout/start ----
  function parseCheckout(b) {
    if (!b) return { err: ['bad_request'] };
    const bad = (field) => ({ err: ['bad_request', { field }] });
    if (typeof b.branch !== 'string' || !b.branch) return bad('branch');
    if (typeof b.slotId !== 'string' || Number.isNaN(Date.parse(b.slotId))) return bad('slotId');
    if (b.method !== 'payu' && b.method !== 'cod') return bad('method');
    if (!Array.isArray(b.items) || b.items.length < 1 || b.items.length > 30) return bad('items');
    const seen = new Set();
    for (const it of b.items) {
      if (!it || typeof it.id !== 'string' || !it.id || it.id.length > 40 || !Number.isInteger(it.qty) || it.qty < 1 || it.qty > 20 || seen.has(it.id)) return bad('items');
      seen.add(it.id);
    }
    const c = b.customer && typeof b.customer === 'object' ? b.customer : {};
    const name = typeof c.name === 'string' ? c.name.trim().slice(0, 60) : '';
    const email = typeof c.email === 'string' ? c.email.trim() : '';
    if (email && !EMAIL.test(email)) return bad('customer.email');
    const k = b.consent;
    if (!k || k.terms !== true) return { err: ['bad_request', { field: 'consent.terms', message: 'Please accept the terms to place your order.' }] };
    if (typeof k.marketing !== 'boolean') return bad('consent.marketing');
    if (typeof k.version !== 'string' || !k.version) return bad('consent.version');
    if (b.expectedTotalPaise !== undefined && !isPaise(b.expectedTotalPaise)) return bad('expectedTotalPaise');
    return { v: { branch: b.branch.toLowerCase(), slotId: b.slotId, method: b.method, items: b.items.map((i) => ({ id: i.id, qty: i.qty })), name, email, consent: { terms: true, marketing: k.marketing, version: k.version }, expectedTotalPaise: b.expectedTotalPaise } };
  }

  async function release(db, key) { try { await db.prepare('DELETE FROM idempotency_keys WHERE key = ? AND order_id IS NULL').bind(key).run(); } catch { /* best effort */ } }

  async function routeCheckoutStart(env, req, db, ctx) {
    const f = flagsOf(env);
    if (!secretsOk(env, ['TOKEN_SIGNING_KEY', 'OTP_HASH_SECRET']) || !deps.quote) return fail(env, req, 503, 'provider_down');
    const mockPay = String(env.PAYMENT_PROVIDER || '').toLowerCase() === 'mock';
    if (mockPay && !f.mocks) return fail(env, req, 503, 'provider_down');
    if (!mockPay && !(env.PAYU_KEY && env.PAYU_SALT && env.API_ORIGIN)) return fail(env, req, 503, 'provider_down');

    const who = await bearer(env, req);
    if (!who.ok) return fail(env, req, 401, 'token_invalid');
    const body = await readJson(req);
    const p = parseCheckout(body);
    if (p.err) return fail(env, req, 400, p.err[0], p.err[1] || {});
    const v = p.v;
    const o = outlet(env, v.branch);
    if (!o) return fail(env, req, 400, 'bad_request', { field: 'branch' });
    if (!o.live) return fail(env, req, 409, 'branch_closed');
    if (env.TERMS_VERSION && v.consent.version !== env.TERMS_VERSION) return fail(env, req, 400, 'bad_request', { field: 'consent.version', message: 'Our terms were updated. Please reload the page and try again.' });

    const idemKey = req.headers.get('Idempotency-Key') || '';
    if (!KEY.test(idemKey)) return fail(env, req, 400, 'bad_request', { field: 'Idempotency-Key' });
    const idem = await beginIdempotent(db, { key: idemKey, phone: who.phone, requestHash: await sha256hex(stable(v)), now: now() });
    if (idem.kind === 'replay') return reply(env, req, idem.response);
    if (idem.kind === 'conflict' || idem.kind === 'in_progress') return fail(env, req, 409, 'idempotency_conflict');
    if (idem.kind !== 'new') return fail(env, req, 400, 'bad_request', { field: 'Idempotency-Key' });

    const stop = async (status, code, extra) => { await release(db, idemKey); return fail(env, req, status, code, extra); };
    try {
      // Contract section 7: 5 placements per 10 minutes per phone. Replays of the same key were answered above and do not count.
      const rl = await rateCheck(db, { bucket: 'checkout_phone', key: who.phone, limit: 5, windowSec: 600, now: now() });
      if (!rl.ok) return stop(429, 'rate_limited', { retryAfterSeconds: rl.retryAfterSeconds });
      if (!validateSlot(v.slotId, { now: now(), open: o.open, close: o.close, minPrepMinutes: o.minPrepMinutes, slotMinutes: o.slotMinutes })) return stop(409, 'slot_invalid');

      let q;
      try { q = await deps.quote(env, { branch: v.branch, ristaCode: o.ristaCode, items: v.items }); } catch { return stop(503, 'provider_down'); }
      if (!q || !q.ok) {
        if (q && q.code === 'item_unavailable') return stop(409, 'item_unavailable', { field: q.field });
        return stop(503, 'provider_down');
      }
      const quote = q.quote;
      const chargesPaise = quote && quote.chargesPaise ? quote.chargesPaise : 0;
      if (!quote || ![quote.subtotalPaise, quote.taxPaise, chargesPaise, quote.totalPaise].every(isPaise) || !Array.isArray(quote.items)) return stop(500, 'internal');
      if (v.expectedTotalPaise !== undefined && v.expectedTotalPaise !== quote.totalPaise) return stop(409, 'quote_mismatch', { details: { totalPaise: quote.totalPaise } });

      // The browser's choice is never trusted: re-check with the SERVER total (plan 7.0).
      const m = checkMethod(v.method, quote.totalPaise, { codMaxPaise: codMaxPaiseFromEnv(env), codAllowedForBranch: o.codAllowed });
      if (!m.ok) return m.code === 'bad_method' ? stop(400, 'bad_request', { field: 'method' }) : stop(400, 'cod_not_allowed');

      // Open-order cap, checked BEFORE the token is spent so a refusal does not burn the customer's code.
      // Same definition as v_open_orders (migration 0002), counted with the handler's clock so it is testable and not tied to the database clock.
      const cap = await db.prepare("SELECT COUNT(*) AS open_count FROM orders WHERE customer_id = (SELECT id FROM customers WHERE phone = ?) AND state IN ('CREATED','PAYMENT_PENDING','PAID','PUSH_FAILED','PUSHED_TO_RISTA','CONFIRMED') AND slot_at > ?").bind(who.phone, new Date(now().getTime() - 2 * 3600 * 1000).toISOString()).first();
      if (cap && cap.open_count >= 2) return stop(429, 'too_many_open_orders');

      if (!(await claimNonce(db, { nonce: who.nonce, phone: who.phone, now: now() }))) return stop(401, 'token_invalid');
      const unclaim = () => db.prepare('UPDATE otp_nonces SET uses = uses - 1 WHERE nonce = ? AND uses > 0').bind(who.nonce).run();

      const st = await newStatusToken();
      const ipHash = await ipHashOf(env, req);
      let created;
      try {
        created = await createOrder(db, {
          branch: v.branch, slotAt: v.slotId, method: v.method,
          items: quote.items.map((it) => ({ ristaItemId: it.id, name: it.name, qty: it.qty, unitPaise: it.unitPaise })),
          subtotalPaise: quote.subtotalPaise, taxPaise: quote.taxPaise, chargesPaise, totalPaise: quote.totalPaise,
          phone: who.phone, name: v.name || null, email: v.email || null, statusTokenHash: st.hash,
          earnPoints: Number.isInteger(quote.earnPoints) ? quote.earnPoints : 0,
          consents: [
            { kind: 'terms', granted: true, wordingVersion: v.consent.version, ipHash },
            { kind: 'marketing', granted: v.consent.marketing, wordingVersion: v.consent.version, ipHash },
          ],
          actor: 'api', now: now(), codMaxPaise: codMaxPaiseFromEnv(env), codAllowedForBranch: o.codAllowed,
        });
      } catch (e) { await unclaim(); console.error('createOrder failed', String(e && e.message).slice(0, 200)); return stop(500, 'internal'); }
      if (!created.ok) {
        await unclaim();
        if (created.code === 'too_many_open_orders') return stop(429, 'too_many_open_orders');
        if (created.code === 'method_not_allowed') return stop(400, 'cod_not_allowed');
        console.error('createOrder refused', created.code);
        return stop(500, 'internal');
      }

      let response;
      if (v.method === 'payu') {
        const siteApi = String(env.API_ORIGIN || '').replace(/\/+$/, '');
        const back = `${siteApi}/api/payu/callback?t=${st.token}`; // the callback needs the plain token to send the customer back to the status page
        const pf = await buildPayuFields({
          key: mockPay ? 'mock' : env.PAYU_KEY, salt: mockPay ? 'mock-salt-staging-only-0000000000000000' : env.PAYU_SALT,
          mode: String(env.PAYU_MODE || 'test').toLowerCase() === 'live' ? 'live' : 'test',
          order: { id: created.orderId, totalPaise: quote.totalPaise },
          customer: { name: v.name, email: v.email, phone: who.phone }, urls: { surl: back, furl: back },
        });
        response = { orderId: created.orderId, statusToken: st.token, state: 'PAYMENT_PENDING', totalPaise: quote.totalPaise, payment: { type: 'payu', action: pf.action, method: 'POST', fields: pf.fields } };
      } else {
        // Pay at pickup: the order reaches Rista unpaid (owner decision). The push is Phase 8; until it exists the order stays CREATED and the page keeps polling.
        if (deps.pushToRista && ctx && ctx.waitUntil) ctx.waitUntil(Promise.resolve(deps.pushToRista(env, { orderId: created.orderId, method: 'cod' })).catch((e) => console.error('rista push failed', String(e && e.message).slice(0, 120))));
        response = { orderId: created.orderId, statusToken: st.token, state: 'CREATED', totalPaise: quote.totalPaise, payment: null };
      }
      await finishIdempotent(db, { key: idemKey, orderId: created.orderId, response });
      return reply(env, req, response);
    } catch (e) {
      console.error('checkout/start failed', String(e && e.message).slice(0, 200));
      return stop(500, 'internal');
    }
  }

  // ---- GET /api/order/status?id=&t= (works even when ordering is switched off: orders already placed must stay readable) ----
  async function routeStatus(env, req, url, db) {
    // task 10.1a: limits per order and (loosely) per IP; a broken limit table never hides an order from its customer
    try {
      const at = now();
      const byOrder = await rateCheck(db, { bucket: 'status_order', key: String(url.searchParams.get('id') || '').slice(0, 40), limit: 150, windowSec: 600, now: at });
      if (!byOrder.ok) return fail(env, req, 429, 'rate_limited', { retryAfterSeconds: byOrder.retryAfterSeconds });
      const byIp = await rateCheck(db, { bucket: 'status_ip', key: await ipHashOf(env, req), limit: 600, windowSec: 600, now: at });
      if (!byIp.ok) return fail(env, req, 429, 'rate_limited', { retryAfterSeconds: byIp.retryAfterSeconds });
    } catch (e) { console.error('status rate check failed', String(e && e.message).slice(0, 120)); }
    const row = await getOrderStatus(db, { id: url.searchParams.get('id') || '', t: url.searchParams.get('t') || '' });
    if (!row) return fail(env, req, 404, 'not_found');
    const o = outletsOf()[row.branch];
    return reply(env, req, { orderId: row.id, state: row.state, method: row.method, totalPaise: row.total_paise, branch: row.branch, branchName: o ? o.name : row.branch, slotLabel: istLabel(row.slot_at), earnPoints: row.earn_points || 0 });
  }

  // ---- PayU callback and webhook: one core, called from both (plan 7.3). Always works, flag or no flag: money may already be taken. ----
  async function processPayu(env, ctx, db, fields, actor) {
    const txnid = String(fields.txnid || '');
    const order = await db.prepare('SELECT id, state, total_paise, status_token_hash FROM orders WHERE id = ?').bind(txnid).first();
    if (!order) return { handled: false };
    const key = env.PAYU_KEY, salt = env.PAYU_SALT;
    if (!key || !salt) return { handled: true, order };
    const vr = await verifyPayuResponse(fields, { key, salt, expectedTxnid: order.id, expectedAmountPaise: order.total_paise });
    if (!vr.ok) {
      // amount_mismatch is only returned after the hash passed, so the posted amount is PayU's own. markPaid records MISMATCH and does NOT move the order.
      if (vr.code === 'amount_mismatch') {
        const paise = rupeesToPaise(fields.amount);
        if (paise) await markPaid(db, { orderId: order.id, txnid: order.id, payuRef: fields.mihpayid || null, amountPaise: paise, actor });
      }
      return { handled: true, order, result: vr.code };
    }
    if (vr.status === 'success') {
      // Plan 7.3: a good hash is not enough. Ask PayU server to server and trust that answer. If we cannot ask, we do NOT mark paid.
      if (!deps.payuVerify) return { handled: true, order, result: 'cannot_verify' };
      let sv;
      try { sv = await deps.payuVerify(env, order.id); } catch { return { handled: true, order, result: 'cannot_verify' }; }
      if (!sv || sv.status !== 'success' || !Number.isInteger(sv.amountPaise)) return { handled: true, order, result: 'not_confirmed' };
      const r = await markPaid(db, { orderId: order.id, txnid: order.id, payuRef: sv.payuRef || vr.payuRef, amountPaise: sv.amountPaise, actor });
      if (r.ok && !r.duplicate && deps.pushToRista && ctx && ctx.waitUntil) ctx.waitUntil(Promise.resolve(deps.pushToRista(env, { orderId: order.id, method: 'payu' })).catch((e) => console.error('rista push failed', String(e && e.message).slice(0, 120))));
      return { handled: true, order, result: r.ok ? 'paid' : r.code };
    }
    // failure or cancel: only an order still waiting for payment can fail
    await transition(db, { orderId: order.id, from: 'PAYMENT_PENDING', to: 'PAYMENT_FAILED', actor, note: `payu ${vr.status}`.slice(0, 40) });
    return { handled: true, order, result: 'failed' };
  }
  async function payuFields(req) {
    const ct = req.headers.get('Content-Type') || '';
    const text = await req.text();
    if (text.length > 20000) return {};
    if (ct.includes('json')) { try { const j = JSON.parse(text); return j && typeof j === 'object' ? Object.fromEntries(Object.entries(j).map(([k, v]) => [k, String(v ?? '')])) : {}; } catch { return {}; } }
    return Object.fromEntries(new URLSearchParams(text));
  }
  async function routePayuCallback(env, req, db, ctx, url) {
    const fields = await payuFields(req);
    let out = { handled: false };
    try { out = await processPayu(env, ctx, db, fields, 'payu_callback'); } catch (e) { console.error('payu callback failed', String(e && e.message).slice(0, 200)); }
    const site = String(env.SITE_ORIGIN || '').replace(/\/+$/, '');
    let to = `${site}/checkout/`;
    const t = url.searchParams.get('t') || '';
    if (out.handled && out.order && t && (await sha256hex(t)) === out.order.status_token_hash) to = `${site}/checkout/?order=${encodeURIComponent(out.order.id)}&t=${encodeURIComponent(t)}`;
    return new Response(null, { status: 303, headers: { Location: to, 'Cache-Control': 'no-store' } });
  }
  async function routePayuWebhook(env, req, db, ctx) {
    const fields = await payuFields(req);
    try { await processPayu(env, ctx, db, fields, 'payu_webhook'); } catch (e) { console.error('payu webhook failed', String(e && e.message).slice(0, 200)); return new Response(JSON.stringify({ ok: false }), { status: 500, headers: { 'Content-Type': 'application/json' } }); }
    return new Response(JSON.stringify({ ok: true }), { status: 200, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' } });
  }

  // ---- POST /api/mock/pay (staging only: PAYMENT_PROVIDER=mock and ALLOW_MOCKS=true; otherwise 404) ----
  async function routeMockPay(env, req, db) {
    const f = flagsOf(env);
    if (!(f.mocks && String(env.PAYMENT_PROVIDER || '').toLowerCase() === 'mock')) return fail(env, req, 404, 'not_found');
    const b = await readJson(req);
    if (!b || typeof b.orderId !== 'string' || typeof b.t !== 'string') return fail(env, req, 400, 'bad_request');
    const st = await getOrderStatus(db, { id: b.orderId, t: b.t });
    if (!st) return fail(env, req, 404, 'not_found');
    if (b.ok === true) await markPaid(db, { orderId: st.id, txnid: st.id, payuRef: 'mock', amountPaise: st.total_paise, actor: 'api' });
    else await transition(db, { orderId: st.id, from: 'PAYMENT_PENDING', to: 'PAYMENT_FAILED', actor: 'api', note: 'mock failure' });
    const now2 = await getOrderStatus(db, { id: b.orderId, t: b.t });
    return reply(env, req, { state: now2.state });
  }

  const ROUTES = {
    '/api/config': { m: 'GET', gated: false },
    '/api/slots': { m: 'GET', gated: true },
    '/api/otp/send': { m: 'POST', gated: true },
    '/api/otp/verify': { m: 'POST', gated: true },
    '/api/loyalty/lookup': { m: 'POST', gated: true },
    '/api/checkout/start': { m: 'POST', gated: true },
    '/api/order/status': { m: 'GET', gated: false },
    '/api/payu/callback': { m: 'POST', gated: false },
    '/api/payu/webhook': { m: 'POST', gated: false },
    '/api/mock/pay': { m: 'POST', gated: false },
  };

  // Returns a Response, or null when the path is not ours (then index.js carries on exactly as before).
  return async function handle(request, env, ctx) {
    const url = new URL(request.url);
    const path = url.pathname.length > 1 ? url.pathname.replace(/\/+$/, '') : url.pathname;
    const route = ROUTES[path];
    if (!route) return null;
    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: corsHeaders(env, request) });
    if (request.method !== route.m) return fail(env, request, 405, 'method_not_allowed', { message: MSG.method_not_allowed });
    try {
      if (path === '/api/config') return routeConfig(env, request);
      const f = flagsOf(env);
      // Gated routes start new customer activity. Status and the PayU routes stay open so a payment already in flight is never lost.
      if (route.gated && !f.live) return fail(env, request, 503, 'ordering_closed');
      if (path === '/api/slots') return routeSlots(env, request, url);
      const db = getDb(env);
      if (!db) return fail(env, request, 503, 'provider_down');
      if (path === '/api/otp/send') return await routeOtpSend(env, request, db);
      if (path === '/api/otp/verify') return await routeOtpVerify(env, request, db);
      if (path === '/api/loyalty/lookup') return await routeLoyalty(env, request);
      if (path === '/api/checkout/start') return await routeCheckoutStart(env, request, db, ctx);
      if (path === '/api/order/status') return await routeStatus(env, request, url, db);
      if (path === '/api/payu/callback') return await routePayuCallback(env, request, db, ctx, url);
      if (path === '/api/payu/webhook') return await routePayuWebhook(env, request, db, ctx);
      if (path === '/api/mock/pay') return await routeMockPay(env, request, db);
      return null;
    } catch (e) {
      console.error('ordering route failed', path, String(e && e.message).slice(0, 200));
      return fail(env, request, 500, 'internal');
    }
  };
}
