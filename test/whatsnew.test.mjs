// node --test test/whatsnew.test.mjs   ("What's new" feed: Instagram ordering + token + announcements + the /api/whats-new route and the hourly cron)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import worker from '../src/index.js';
import { pickInstagram, fetchInstagramFeed, refreshIgToken, whatsNewCron, whatsNewData, liveAnnouncements, getAnnouncements, FEED_MAX_AGE_MS, REFRESH_EVERY_MS } from '../src/whatsnew.js';

const TOKEN = 'IGAAtesttoken1234567890abcdefghijklmnopqrstuvwxyz';
const kv = () => { const m = new Map(); return { m, get: async (k) => (m.has(k) ? m.get(k) : null), put: async (k, v) => { m.set(k, String(v)); } }; };
const NOW = Date.parse('2026-11-01T12:00:00Z');
const post = (i, o = {}) => ({ id: 'p' + i, caption: 'Biryani ' + i, media_type: 'IMAGE', media_product_type: 'FEED', media_url: `https://scontent.cdninstagram.com/p${i}.jpg`,
  permalink: `https://www.instagram.com/p/P${i}/`, timestamp: new Date(NOW - i * 3600e3).toISOString(), ...o });
const reel = (i, o = {}) => post(i, { media_type: 'VIDEO', media_product_type: 'REELS', media_url: `https://scontent.cdninstagram.com/r${i}.mp4`, thumbnail_url: `https://scontent.cdninstagram.com/r${i}.jpg`, permalink: `https://www.instagram.com/reel/R${i}/`, ...o });
const json = (b, status = 200) => new Response(JSON.stringify(b), { status, headers: { 'Content-Type': 'application/json' } });

test('#rroffer posts come first, then reels, then photos; newest first inside each group', () => {
  const items = pickInstagram([post(1), reel(2), post(3, { caption: 'Weekend deal #RROffer 20% off' }), reel(4), post(5, { caption: '#rroffer combo' }), post(6)]);
  assert.deepEqual(items.map((i) => i.id), ['p3', 'p5', 'p2', 'p4', 'p1', 'p6']);
  assert.deepEqual(items.map((i) => [i.kind, i.offer]), [['photo', true], ['photo', true], ['reel', false], ['reel', false], ['photo', false], ['photo', false]]);
  assert.equal(items[0].caption, 'Weekend deal 20% off');   // hashtags are not shown
});

test('at most 9 items, and posts without a usable picture or a real Instagram link are dropped', () => {
  const raw = Array.from({ length: 20 }, (_, i) => post(i));
  assert.equal(pickInstagram(raw).length, 9);
  const bad = pickInstagram([post(1, { permalink: 'https://evil.example/p/1' }), post(2, { media_url: 'http://x/y.jpg' }), post(3, { permalink: 'javascript:alert(1)' }), reel(4, { thumbnail_url: undefined, media_url: 'http://x/v.mp4' }), post(5)]);
  assert.deepEqual(bad.map((i) => i.id), ['p5']);
});

test('a reel carries its video and its poster; a photo carries only the picture', () => {
  const [r] = pickInstagram([reel(1)]); const [p] = pickInstagram([post(1)]);
  assert.equal(r.video, 'https://scontent.cdninstagram.com/r1.mp4'); assert.equal(r.image, 'https://scontent.cdninstagram.com/r1.jpg');
  assert.equal(p.video, null); assert.equal(p.image, 'https://scontent.cdninstagram.com/p1.jpg');
});

test('no token: the hourly job does nothing and the endpoint says live:false with no items', async () => {
  const env = { RR_KV: kv() };
  const r = await fetchInstagramFeed(env, { fetchFn: async () => { throw new Error('must not call Instagram'); } });
  assert.deepEqual(r, { ok: false, reason: 'no_token' });
  const d = await whatsNewData(env, { fetchFn: async () => json({ result: [] }), now: NOW });
  assert.deepEqual(d.instagram, { items: [], fetchedAt: null, live: false });
  assert.deepEqual(d.announcements, []);
});

test('hourly job: stores the picked feed and time in KV; the token goes only in the request, never into KV or the answer', async () => {
  const env = { RR_KV: kv(), IG_TOKEN: TOKEN }; const urls = [];
  const fetchFn = async (u) => { urls.push(String(u)); return json({ data: [post(1), reel(2), post(3, { caption: '#rroffer' })] }); };
  const r = await fetchInstagramFeed(env, { fetchFn, now: NOW });
  assert.deepEqual(r, { ok: true, count: 3 });
  assert.match(urls[0], /^https:\/\/graph\.instagram\.com\/me\/media\?fields=.*limit=20&access_token=/);
  assert.equal(JSON.parse(env.RR_KV.m.get('ig:feed'))[0].id, 'p3');
  assert.equal(env.RR_KV.m.get('ig:fetchedAt'), new Date(NOW).toISOString());
  for (const v of env.RR_KV.m.values()) assert.ok(!v.includes(TOKEN));
  const d = await whatsNewData(env, { fetchFn: async () => json({ result: [] }), now: NOW + 60e3 });
  assert.equal(d.instagram.live, true); assert.equal(d.instagram.items.length, 3);
  assert.ok(!JSON.stringify(d).includes(TOKEN) && !JSON.stringify(d).includes('access_token'));
});

test('Instagram down or token rejected: the last good feed stays; after 24 h it is live:false so the site shows its own reels', async () => {
  const env = { RR_KV: kv(), IG_TOKEN: TOKEN };
  await fetchInstagramFeed(env, { fetchFn: async () => json({ data: [post(1)] }), now: NOW });
  const bad = await fetchInstagramFeed(env, { fetchFn: async () => json({ error: { message: 'Invalid OAuth access token ' + TOKEN } }, 400), now: NOW + 3600e3 });
  assert.equal(bad.ok, false); assert.ok(!JSON.stringify(bad).includes(TOKEN));
  const thrown = await fetchInstagramFeed(env, { fetchFn: async () => { throw new Error('boom access_token=' + TOKEN); }, now: NOW });
  assert.ok(!JSON.stringify(thrown).includes(TOKEN));
  const noAnn = async () => json({ result: [] });
  assert.equal((await whatsNewData(env, { fetchFn: noAnn, now: NOW + 3600e3 })).instagram.live, true);
  assert.equal((await whatsNewData(env, { fetchFn: noAnn, now: NOW + FEED_MAX_AGE_MS + 1000 })).instagram.live, false);
});

test('token refresh: first run only stamps; when a week old it refreshes and the NEW token goes to KV and is used first', async () => {
  const env = { RR_KV: kv(), IG_TOKEN: TOKEN }; const NEW = 'IGAAnewtoken0987654321zyxwvutsrqponmlkjihgfedcba';
  const never = async () => { throw new Error('no network on stamp'); };
  assert.deepEqual(await refreshIgToken(env, { fetchFn: never, now: NOW }), { ok: true, skipped: 'stamped' });
  assert.deepEqual(await refreshIgToken(env, { fetchFn: never, now: NOW + 3 * 86400e3 }), { ok: true, skipped: 'not_due' });
  const urls = [];
  const r = await refreshIgToken(env, { fetchFn: async (u) => { urls.push(String(u)); return json({ access_token: NEW, token_type: 'bearer', expires_in: 5184000 }); }, now: NOW + REFRESH_EVERY_MS + 1000 });
  assert.equal(r.refreshed, true);
  assert.match(urls[0], /refresh_access_token\?grant_type=ig_refresh_token&access_token=/);
  assert.equal(env.RR_KV.m.get('ig:token'), NEW);
  assert.equal(env.RR_KV.m.get('ig:tokenAt'), new Date(NOW + REFRESH_EVERY_MS + 1000).toISOString());
  const seen = []; await fetchInstagramFeed(env, { fetchFn: async (u) => { seen.push(String(u)); return json({ data: [] }); }, now: NOW });
  assert.ok(seen[0].includes(NEW) && !seen[0].includes(TOKEN));   // KV token wins over the secret
});

test('token refresh fails twice: ONE alert (no token in it); a later success clears the count', async () => {
  const env = { RR_KV: kv(), IG_TOKEN: TOKEN }; const alerts = [];
  await refreshIgToken(env, { now: NOW });   // stamp
  const due = NOW + REFRESH_EVERY_MS + 1000, fail = async () => json({ error: { message: 'expired ' + TOKEN } }, 400);
  const a = await refreshIgToken(env, { fetchFn: fail, now: due, alert: async (t) => alerts.push(t) });
  assert.deepEqual([a.ok, a.fails, alerts.length], [false, 1, 0]);
  const b = await refreshIgToken(env, { fetchFn: fail, now: due + 3600e3, alert: async (t) => alerts.push(t) });
  assert.deepEqual([b.ok, b.fails, alerts.length], [false, 2, 1]);
  await refreshIgToken(env, { fetchFn: fail, now: due + 7200e3, alert: async (t) => alerts.push(t) });
  assert.equal(alerts.length, 1); assert.ok(!alerts[0].includes(TOKEN));
  await refreshIgToken(env, { fetchFn: async () => json({ access_token: 'x'.repeat(40) }), now: due + 8000e3 });
  assert.equal(env.RR_KV.m.get('ig:refreshFails'), '0');
});

const row = (o = {}) => ({ line: 'Family combo today', link: '/order-now/', startsAt: '2026-10-30T00:00:00Z', endsAt: '2026-11-05T00:00:00Z', img: 'https://cdn.sanity.io/images/m8b62ufn/production/a-800x600.jpg', img2: null, alt: 'Biryani', alt2: '', ...o });

test('announcements: only inside the start/end window; after the end the card is gone; max 2; one of line / second image', () => {
  const rows = [row({ line: 'A' }), row({ line: 'Old', endsAt: '2026-10-31T00:00:00Z' }), row({ line: 'Soon', startsAt: '2026-11-02T00:00:00Z' }),
    row({ line: '', img2: 'https://cdn.sanity.io/images/m8b62ufn/production/b-800x600.jpg' }), row({ line: 'C' }), row({ line: 'both', img2: 'https://cdn.sanity.io/images/m8b62ufn/production/c-800x600.jpg' }), row({ line: '' })];
  const out = liveAnnouncements(rows, NOW);
  assert.deepEqual(out.map((a) => a.line), ['A', '']);   // 2 max, in order; 'both' and 'neither' are never output
  assert.equal(out[1].img2, 'https://cdn.sanity.io/images/m8b62ufn/production/b-800x600.jpg?w=900&auto=format');
  assert.equal(out[0].img, 'https://cdn.sanity.io/images/m8b62ufn/production/a-800x600.jpg?w=900&auto=format');
  assert.deepEqual(liveAnnouncements(rows, Date.parse('2026-11-06T00:00:00Z')), []);   // all ended
  assert.equal(liveAnnouncements([row({ link: 'javascript:alert(1)' })], NOW)[0].link, '/order-now/');
});

test('announcements: cached 5 min in KV; Sanity down -> last good answer; no cache and down -> none', async () => {
  const env = { RR_KV: kv() }; let calls = 0, up = true;
  const fetchFn = async (u) => { calls++; assert.match(String(u), /^https:\/\/m8b62ufn\.apicdn\.sanity\.io\/v2025-01-01\/data\/query\/production\?query=/); return up ? json({ result: [row()] }) : json({}, 503); };
  assert.equal((await getAnnouncements(env, { fetchFn, now: NOW })).length, 1);
  await getAnnouncements(env, { fetchFn, now: NOW + 120e3 }); assert.equal(calls, 1);
  up = false;
  assert.equal((await getAnnouncements(env, { fetchFn, now: NOW + 400e3 })).length, 1); assert.equal(calls, 2);
  assert.deepEqual(await getAnnouncements({ RR_KV: kv() }, { fetchFn, now: NOW }), []);
});

test('route: GET /api/whats-new answers with cache header and CORS for the site; other origins get no CORS header; POST is refused', async () => {
  const env = { RR_KV: kv(), IG_TOKEN: TOKEN, ALLOWED_ORIGINS: 'https://site.example' };
  await fetchInstagramFeed(env, { fetchFn: async () => json({ data: [post(1), reel(2)] }), now: Date.now() });
  const real = globalThis.fetch; globalThis.fetch = async () => json({ result: [row({ startsAt: '2020-01-01T00:00:00Z', endsAt: '2099-01-01T00:00:00Z' })] });
  try {
    const res = await worker.fetch(new Request('https://api.example/api/whats-new', { headers: { Origin: 'https://site.example' } }), env, { waitUntil() {} });
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('Cache-Control'), 'public, max-age=300');
    assert.equal(res.headers.get('Access-Control-Allow-Origin'), 'https://site.example');
    const body = await res.text(); assert.ok(!body.includes(TOKEN));
    const j = JSON.parse(body);
    assert.equal(j.announcements.length, 1); assert.equal(j.instagram.live, true); assert.equal(j.instagram.items.length, 2);
    const other = await worker.fetch(new Request('https://api.example/api/whats-new', { headers: { Origin: 'https://evil.example' } }), env, { waitUntil() {} });
    assert.equal(other.headers.get('Access-Control-Allow-Origin'), null);
    assert.equal((await worker.fetch(new Request('https://api.example/api/whats-new', { method: 'POST' }), env, { waitUntil() {} })).status, 405);
  } finally { globalThis.fetch = real; }
});

test('cron "0 * * * *" runs the Instagram job even with no database bound; other crons still need the database', async () => {
  const env = { RR_KV: kv(), IG_TOKEN: TOKEN }; const w = [];
  const real = globalThis.fetch; let hit = 0; globalThis.fetch = async () => { hit++; return json({ data: [post(1)] }); };
  try {
    worker.scheduled({ cron: '0 * * * *' }, env, { waitUntil: (p) => w.push(p) }); await Promise.all(w);
    assert.equal(hit, 1);   // first run stamps the token (no refresh call), then one feed call
    assert.ok(env.RR_KV.m.has('ig:feed'));
    worker.scheduled({ cron: '*/10 * * * *' }, env, { waitUntil: (p) => w.push(p) });
    assert.equal(hit, 1);
  } finally { globalThis.fetch = real; }
});

test('whatsNewCron returns both results', async () => {
  const env = { RR_KV: kv(), IG_TOKEN: TOKEN };
  const r = await whatsNewCron(env, { fetchFn: async () => json({ data: [post(1)] }), now: NOW });
  assert.equal(r.refresh.skipped, 'stamped'); assert.equal(r.feed.ok, true);
});
