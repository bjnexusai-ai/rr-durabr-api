// "What's new at RR Durbar" feed (home page): CMS announcements (Sanity public dataset) + latest Instagram posts of @rr_durbar.
//   GET /api/whats-new  ->  { announcements:[<=2], instagram:{ items:[<=9], fetchedAt, live } }
// Jobs (cron "0 * * * *", every hour): fetch the Instagram feed into KV `ig:feed`; refresh the long-lived token once a week into KV `ig:token`.
// Secret: IG_TOKEN (set in Cloudflare, never in git). The token is NEVER put in a response, a log line or an alert.
// KV keys: ig:feed (json), ig:fetchedAt, ig:token, ig:tokenAt, ig:refreshFails, wn:ann (json, 5 min cache).

export const IG_FIELDS = 'id,caption,media_type,media_product_type,media_url,thumbnail_url,permalink,timestamp';
export const MAX_ITEMS = 9;
export const FEED_MAX_AGE_MS = 24 * 3600 * 1000;      // older than this: the CDN links may be dead, so the site shows its own reels
export const REFRESH_EVERY_MS = 7 * 24 * 3600 * 1000;  // token refresh: weekly
export const ANN_TTL_MS = 5 * 60 * 1000;
const IG_GRAPH = 'https://graph.instagram.com';
const OFFER_TAG = /#rroffer\b/i;

const isHttps = (u) => typeof u === 'string' && /^https:\/\//i.test(u);
const safeLink = (u) => (typeof u === 'string' && /^(https:\/\/|\/(?!\/))/.test(u) ? u : '/order-now/');
const redact = (s, token) => { let t = String(s == null ? '' : s); if (token) t = t.split(token).join('***'); return t.replace(/access_token=[^&\s"]+/gi, 'access_token=***').slice(0, 200); };

/* ---------- Instagram: pick and order what the site shows ---------- */
export function cleanCaption(c) {
  const first = String(c || '').split(/\r?\n/).map((x) => x.trim()).find(Boolean) || '';
  return first.replace(/#\w+/g, '').replace(/\s{2,}/g, ' ').trim().slice(0, 110);
}

// Raw Graph items -> at most 9: #rroffer posts first (gold OFFER badge), then reels, then photo posts; newest first inside each group.
export function pickInstagram(raw) {
  const out = [];
  for (const m of Array.isArray(raw) ? raw : []) {
    if (!m || typeof m !== 'object' || !m.id || !isHttps(m.permalink) || !/^https:\/\/(www\.)?instagram\.com\//i.test(m.permalink)) continue;
    const isVideo = m.media_type === 'VIDEO';
    const isReel = isVideo || m.media_product_type === 'REELS';
    const image = isVideo ? (m.thumbnail_url || null) : (m.media_type === 'CAROUSEL_ALBUM' ? (m.thumbnail_url || m.media_url) : m.media_url);
    if (!isHttps(image) && !(isVideo && isHttps(m.media_url))) continue;   // nothing to show
    out.push({
      id: String(m.id), kind: isReel ? 'reel' : 'photo', offer: OFFER_TAG.test(m.caption || ''), caption: cleanCaption(m.caption),
      permalink: m.permalink, timestamp: m.timestamp || null,
      image: isHttps(image) ? image : null, video: isVideo && isHttps(m.media_url) ? m.media_url : null,
    });
  }
  const rank = (i) => (i.offer ? 0 : i.kind === 'reel' ? 1 : 2);
  const t = (i) => Date.parse(i.timestamp) || 0;
  return out.sort((a, b) => rank(a) - rank(b) || t(b) - t(a)).slice(0, MAX_ITEMS);
}

/* ---------- KV helpers (a missing KV never throws: the feed is simply off) ---------- */
const kvGet = async (env, k) => { try { return env.RR_KV ? await env.RR_KV.get(k) : null; } catch { return null; } };
const kvPut = async (env, k, v, opts) => { if (env.RR_KV) await env.RR_KV.put(k, v, opts); };
const igToken = async (env) => (await kvGet(env, 'ig:token')) || env.IG_TOKEN || null;

/* ---------- hourly job ---------- */
export async function fetchInstagramFeed(env, { fetchFn = fetch, now = Date.now() } = {}) {
  const token = await igToken(env);
  if (!token) return { ok: false, reason: 'no_token' };
  try {
    const url = `${IG_GRAPH}/me/media?fields=${IG_FIELDS}&limit=20&access_token=${encodeURIComponent(token)}`;
    const r = await fetchFn(url, { signal: AbortSignal.timeout(10000) });
    if (!r.ok) return { ok: false, reason: 'http_' + r.status };
    const j = await r.json();
    if (!Array.isArray(j && j.data)) return { ok: false, reason: 'bad_reply' };
    const items = pickInstagram(j.data);
    await kvPut(env, 'ig:feed', JSON.stringify(items));
    await kvPut(env, 'ig:fetchedAt', new Date(now).toISOString());
    return { ok: true, count: items.length };
  } catch (e) { return { ok: false, reason: 'error: ' + redact(e && e.message, token) }; }   // the old feed stays in KV
}

// Weekly. A token only refreshes once it is >= 24 h old; a brand-new secret is stamped as fresh on its first run instead of refreshed.
export async function refreshIgToken(env, { fetchFn = fetch, now = Date.now(), alert = async () => {} } = {}) {
  const token = await igToken(env);
  if (!token) return { ok: false, reason: 'no_token' };
  const last = Date.parse((await kvGet(env, 'ig:tokenAt')) || '');
  if (!Number.isFinite(last)) { await kvPut(env, 'ig:tokenAt', new Date(now).toISOString()); return { ok: true, skipped: 'stamped' }; }
  if (now - last < REFRESH_EVERY_MS) return { ok: true, skipped: 'not_due' };
  let reason = null;
  try {
    const r = await fetchFn(`${IG_GRAPH}/refresh_access_token?grant_type=ig_refresh_token&access_token=${encodeURIComponent(token)}`, { signal: AbortSignal.timeout(10000) });
    const j = r.ok ? await r.json() : null;
    if (j && typeof j.access_token === 'string' && j.access_token.length > 20) {
      await kvPut(env, 'ig:token', j.access_token);          // Workers cannot rewrite secrets: the new token lives in KV and wins over IG_TOKEN
      await kvPut(env, 'ig:tokenAt', new Date(now).toISOString());
      await kvPut(env, 'ig:refreshFails', '0');
      return { ok: true, refreshed: true };
    }
    reason = r.ok ? 'bad_reply' : 'http_' + r.status;
  } catch (e) { reason = 'error: ' + redact(e && e.message, token); }
  const fails = (Number.parseInt(await kvGet(env, 'ig:refreshFails'), 10) || 0) + 1;
  await kvPut(env, 'ig:refreshFails', String(fails));
  if (fails === 2) await alert('Instagram token refresh failed twice (' + reason + '). Generate a new token in the Meta app and set IG_TOKEN.');
  return { ok: false, reason, fails };
}

export async function whatsNewCron(env, opts = {}) {
  const refresh = await refreshIgToken(env, opts);
  const feed = await fetchInstagramFeed(env, opts);
  return { refresh, feed };
}

/* ---------- announcements (Sanity public dataset, no token) ---------- */
export function annQuery(now = Date.now()) {
  const since = new Date(now - 24 * 3600 * 1000).toISOString().slice(0, 10);   // day granularity keeps the CDN cache useful; exact dates are checked below
  return `*[_type=="announcement" && active!=false && endsAt>"${since}"]|order(sort asc)[0..19]{line,link,startsAt,endsAt,"img":image.asset->url,"img2":image2.asset->url,"alt":image.alt,"alt2":image2.alt}`;
}

export function liveAnnouncements(rows, now = Date.now()) {
  return (Array.isArray(rows) ? rows : [])
    .filter((a) => a && isHttps(a.img) && Date.parse(a.startsAt) <= now && now < Date.parse(a.endsAt))
    .filter((a) => (a.line && String(a.line).trim() ? 1 : 0) + (isHttps(a.img2) ? 1 : 0) === 1)   // exactly one of line / second image
    .map((a) => ({
      line: a.line && String(a.line).trim() ? String(a.line).trim().slice(0, 120) : '',
      link: safeLink(a.link), startsAt: a.startsAt, endsAt: a.endsAt,
      img: a.img + '?w=900&auto=format', img2: isHttps(a.img2) ? a.img2 + '?w=900&auto=format' : null,
      alt: String(a.alt || '').slice(0, 160), alt2: String(a.alt2 || '').slice(0, 160),
    }))
    .slice(0, 2);
}

export async function getAnnouncements(env, { fetchFn = fetch, now = Date.now() } = {}) {
  let cachedRows = null;
  try { const c = JSON.parse((await kvGet(env, 'wn:ann')) || 'null'); if (c && Array.isArray(c.rows)) { if (now - c.t < ANN_TTL_MS) return liveAnnouncements(c.rows, now); cachedRows = c.rows; } } catch { /* ignore */ }
  try {
    const project = env.SANITY_PROJECT_ID || 'm8b62ufn', dataset = env.SANITY_DATASET || 'production';
    const r = await fetchFn(`https://${project}.apicdn.sanity.io/v2025-01-01/data/query/${dataset}?query=${encodeURIComponent(annQuery(now))}`, { signal: AbortSignal.timeout(8000) });
    if (!r.ok) throw new Error('http_' + r.status);
    const j = await r.json();
    const rows = Array.isArray(j && j.result) ? j.result : [];
    await kvPut(env, 'wn:ann', JSON.stringify({ t: now, rows }));
    return liveAnnouncements(rows, now);
  } catch (e) {
    console.error('announcements failed:', redact(e && e.message));
    return cachedRows ? liveAnnouncements(cachedRows, now) : [];   // last good answer, else row 1 simply stays hidden
  }
}

/* ---------- GET /api/whats-new ---------- */
export async function whatsNewData(env, { fetchFn = fetch, now = Date.now() } = {}) {
  let items = [], fetchedAt = null, live = false;
  try {
    fetchedAt = await kvGet(env, 'ig:fetchedAt');
    const feed = JSON.parse((await kvGet(env, 'ig:feed')) || '[]');
    const fresh = fetchedAt && now - Date.parse(fetchedAt) < FEED_MAX_AGE_MS;
    if (Array.isArray(feed) && feed.length && fresh) { items = feed.slice(0, MAX_ITEMS); live = true; }
  } catch { /* feed off */ }
  return { announcements: await getAnnouncements(env, { fetchFn, now }), instagram: { items, fetchedAt: live ? fetchedAt : null, live } };
}
