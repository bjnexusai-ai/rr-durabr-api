// RR Durbar Rista gateway. Cloudflare Worker.
// Routes:
//   GET  /api/health            quick check
//   GET  /api/outlets           6 outlets: open/closed/call, hours, lat/lng
//   GET  /api/menu?branch=MR    dishes + sold-out marks + photo links + "orderable" flag. NO prices.
//   POST /api/quote             prices for a cart, worked out here from Rista (Website channel)
//   GET  /api/debug?...         raw Rista reply, owner only (needs DEBUG_TOKEN)
// Secrets (set in Cloudflare, never in GitHub): RISTA_KEY, RISTA_SECRET, DEBUG_TOKEN
import { OUTLETS, FALLBACK_HOURS, PHONE, TTL, STALE_OK, STALE_PHOTOS, PHOTO_RETRY } from './config.js';
import { cached, isBackedOff, setBackoff } from './cache.js';
import { ristaGet, RistaError } from './rista.js';
import { parseBranchList, parseOutletStatus, parseWeek, weekFromRange, hoursView, istNow, isOpenWeek, sameName, soldOutSet, buildMenu, buildPhotoIndex, photosFor } from './transform.js';
import { readRequest, makeQuote, pricesFor } from './quote.js';
import { handleOrder } from './order.js';

const DEBUG_PATHS = ['/branch/list', '/branch', '/outlet/status', '/outlet/delivery/timings', '/items/soldout', '/stockStatus', '/catalog', '/catalog/enterprise', '/catalog/item/list'];

function cors(env, req) {
  const allowed = (env.ALLOWED_ORIGINS || '').split(',').map((s) => s.trim()).filter(Boolean);
  const o = req.headers.get('Origin');
  const h = { Vary: 'Origin' };
  if (o && allowed.includes(o)) {
    h['Access-Control-Allow-Origin'] = o;
    h['Access-Control-Allow-Methods'] = 'GET, POST, OPTIONS';
    h['Access-Control-Allow-Headers'] = 'Content-Type';
    h['Access-Control-Max-Age'] = '86400';
  }
  return h;
}

function reply(env, req, data, status = 200, cacheSecs = 20) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': status === 200 && cacheSecs > 0 ? `public, max-age=${cacheSecs}` : 'no-store',
      'X-Content-Type-Options': 'nosniff',
      ...cors(env, req),
    },
  });
}

const same = (a, b) => {
  if (typeof a !== 'string' || typeof b !== 'string' || a.length !== b.length) return false;
  let d = 0;
  for (let i = 0; i < a.length; i++) d |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return d === 0;
};

const channelOf = (env) => env.CHANNEL || 'Website';

/* ---------- /api/outlets ---------- */
async function outletsData(env) {
  let anyStale = false;
  const mark = (r) => { if (r.stale) anyStale = true; return r.value; };
  const channel = channelOf(env);

  // GET /branch/list: name, address, lat/lng, status AND the channel names of each branch
  let branches = {};
  try { branches = parseBranchList(mark(await cached('branches', TTL.branches, STALE_OK, () => ristaGet(env, '/branch/list')))); }
  catch (e) { console.error('branch/list failed:', e.message); }

  const now = istNow();

  const outlets = await Promise.all(OUTLETS.map(async (o) => {
    const b = branches[o.code] || null;
    const hasChannel = b && b.channels ? b.channels.some((c) => sameName(c, channel)) : null;   // null = not known

    // Optional extra: channel on/off at an aggregator. Only used if ORDER_SOURCE is set (Rista needs it on this call).
    let orderStatus = null;
    if (env.ORDER_SOURCE && hasChannel) {
      try {
        orderStatus = parseOutletStatus(mark(await cached(`status:${o.code}`, TTL.status, STALE_OK, () =>
          ristaGet(env, '/outlet/status', { branch: o.code, channel, orderSource: env.ORDER_SOURCE }))));
      } catch (e) { console.error(`status ${o.code} failed:`, e.message); }
    }

    // GET /branch?branchCode=XX : business hours
    let week = null, hoursSource = null;
    try {
      week = parseWeek(mark(await cached(`hours:${o.code}`, TTL.branches, STALE_OK, () =>
        ristaGet(env, '/branch', { branchCode: o.code }))));
      if (week) hoursSource = 'rista';
    } catch (e) { console.error(`hours ${o.code} failed:`, e.message); }
    if (!week && FALLBACK_HOURS[o.code]) { week = weekFromRange(FALLBACK_HOURS[o.code]); hoursSource = 'fallback'; }

    let state;
    if (hasChannel === null) state = 'unknown';                                   // Rista did not tell us the channels
    else if (!hasChannel) state = 'call';                                         // no pickup channel in Rista yet
    else if (b.active === false) state = 'closed';                                // branch switched off in Rista
    else if (orderStatus && orderStatus.channelFound && !orderStatus.active) state = 'closed';
    else state = isOpenWeek(week, now) === false ? 'closed' : 'open';

    return {
      code: o.code, slug: o.slug, name: o.name, tag: o.tag || null,
      phone: PHONE,
      address: b?.address || null,
      lat: b?.lat ?? o.lat ?? null, lng: b?.lng ?? o.lng ?? null,   // Rista first, then hand-typed values in config.js
      hours: hoursView(week, now, hoursSource),                      // today's slots: { open, close, slots:[{open,close}], source }
      pickup: { available: hasChannel, accepting: orderStatus ? orderStatus.active : null },
      status: state,   // open | closed | call | unknown
    };
  }));

  return { outlets, stale: anyStale, generatedAt: new Date().toISOString() };
}

/* ---------- shared: catalog + sold-out marks for one outlet (used by menu AND quote) ---------- */
async function loadCatalog(env, code) {
  const channel = channelOf(env);
  return cached(`menu:${code}`, TTL.menu, STALE_OK, () => ristaGet(env, '/catalog', { branch: code, channel }));
}

async function loadSold(env, code) {
  const channel = channelOf(env);
  let sold = null, soldSource = null, stale = false;
  // Best source: GET /stockStatus (sold-out per branch AND channel). Backup: GET /items/soldout (per branch).
  try {
    const s = await cached(`stock:${code}`, TTL.soldout, STALE_OK, async () => {
      const j = await ristaGet(env, '/stockStatus', { branch: code, channel });
      if (!Array.isArray(j?.stockOut)) throw new Error('unexpected stockStatus reply');
      return j;
    });
    if (s.stale) stale = true;
    sold = soldOutSet(s.value); soldSource = 'stockStatus';
  } catch (e) {
    console.error(`stockStatus ${code} failed:`, e.message);
    try {
      const s = await cached(`soldout:${code}`, TTL.soldout, STALE_OK, () => ristaGet(env, '/items/soldout', { branch: code }));
      if (s.stale) stale = true;
      sold = soldOutSet(s.value); soldSource = 'soldout';
    } catch (e2) { console.error(`soldout ${code} failed:`, e2.message); }
  }
  return { sold, soldSource, stale };
}

/* ---------- /api/menu ---------- */
async function menuData(env, code) {
  const channel = channelOf(env);
  let stale = false;

  const cat = await loadCatalog(env, code);
  if (cat.stale) stale = true;

  const { sold, soldSource, stale: soldStale } = await loadSold(env, code);
  if (soldStale) stale = true;

  // Dish photos (optional). Whole-business reply, so kept 30 min and reduced to photo links only.
  // If it fails the menu still works, just without Rista dish photos. We do not retry for 2 minutes.
  let photos = null;
  if (!isBackedOff('photos')) {
    try {
      const p = await cached('photos', TTL.photos, STALE_PHOTOS, async () =>
        buildPhotoIndex(await ristaGet(env, '/catalog/enterprise', {}, { timeoutMs: 15000 })));
      if (p.stale) stale = true;
      photos = photosFor(p.value, code, channel);
    } catch (e) {
      console.error('photos failed:', e.message);
      setBackoff('photos', PHOTO_RETRY);
    }
  }

  const { categories, count } = buildMenu(cat.value, sold, photos);
  const photoCount = categories.reduce((n, c) => n + c.items.filter((i) => i.imageSource === 'rista').length, 0);
  return { branch: code, count, soldOutKnown: sold !== null, soldOutSource: soldSource, photosKnown: photos !== null, photoCount, categories, stale, generatedAt: new Date().toISOString() };
}

/* ---------- POST /api/quote ---------- */
async function quote(env, req) {
  let text = '';
  try { text = await req.text(); } catch { return reply(env, req, { error: 'bad_request' }, 400); }
  if (text.length > 8000) return reply(env, req, { error: 'too_big' }, 413);
  let body = null;
  try { body = JSON.parse(text); } catch { return reply(env, req, { error: 'bad_request' }, 400); }

  const code = String(body?.branch || '').toUpperCase();
  if (!OUTLETS.some((o) => o.code === code)) return reply(env, req, { error: 'unknown_branch' }, 400);
  const r = readRequest(body);
  if (!r.ok) return reply(env, req, { error: r.error }, 400);

  const cat = await loadCatalog(env, code);
  const { sold, stale: soldStale } = await loadSold(env, code);
  const q = makeQuote(cat.value, sold, r.items);
  return reply(env, req, { branch: code, ...q, stale: Boolean(cat.stale || soldStale), generatedAt: new Date().toISOString() }, 200, 0);
}

/* ---------- /api/debug (owner only) ---------- */
async function debug(env, req, url) {
  if (!env.DEBUG_TOKEN || !same(url.searchParams.get('token'), env.DEBUG_TOKEN)) return reply(env, req, { error: 'not_found' }, 404);
  const path = url.searchParams.get('path');
  if (!DEBUG_PATHS.includes(path)) return reply(env, req, { error: 'bad_path', allowed: DEBUG_PATHS }, 400);
  const params = {};
  for (const [k, v] of url.searchParams) if (k !== 'token' && k !== 'path') params[k] = v;
  try {
    const raw = await ristaGet(env, path, params);   // raw reply: may contain prices. Owner only.
    return new Response(JSON.stringify(raw, null, 2), {
      headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'X-Robots-Tag': 'noindex' },
    });
  } catch (e) {
    return reply(env, req, { error: 'rista_error', status: e.status ?? null }, 502);
  }
}

export default {
  async fetch(req, env) {
    const url = new URL(req.url);
    if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors(env, req) });
    const isQuote = url.pathname === '/api/quote';
    const isOrder = url.pathname === '/api/order';
    if (isQuote || isOrder ? req.method !== 'POST' : (req.method !== 'GET' && req.method !== 'HEAD')) return reply(env, req, { error: 'method_not_allowed' }, 405);

    try {
      if (url.pathname === '/api/health') return reply(env, req, { ok: true, configured: Boolean(env.RISTA_KEY && env.RISTA_SECRET) }, 200, 5);
      if (url.pathname === '/api/outlets') return reply(env, req, await outletsData(env));
      if (url.pathname === '/api/menu') {
        const code = (url.searchParams.get('branch') || '').toUpperCase();
        if (!OUTLETS.some((o) => o.code === code)) return reply(env, req, { error: 'unknown_branch' }, 400);
        return reply(env, req, await menuData(env, code));
      }
      if (isQuote) return await quote(env, req);
      if (isOrder) { const r = await handleOrder(env, req, { outlets: OUTLETS, channel: channelOf(env), loadCatalog, loadSold }); return reply(env, req, r.data, r.status, 0); }
      if (url.pathname === '/api/prices') {
        const code = (url.searchParams.get('branch') || '').toUpperCase();
        if (!OUTLETS.some((o) => o.code === code)) return reply(env, req, { error: 'unknown_branch' }, 400);
        const cat = await loadCatalog(env, code);
        return reply(env, req, { branch: code, prices: pricesFor(cat.value), stale: Boolean(cat.stale), generatedAt: new Date().toISOString() }, 200, 30);
      }
      if (url.pathname === '/api/debug') return debug(env, req, url);
      return reply(env, req, { error: 'not_found' }, 404);
    } catch (e) {
      console.error('request failed:', e.message);   // message never contains key or secret
      if (e instanceof RistaError && e.status === 0) return reply(env, req, { error: 'not_configured' }, 500);
      return reply(env, req, { error: 'rista_unavailable' }, 502);
    }
  },
};
