import test from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import worker from '../src/index.js';
import { signJwt } from '../src/jwt.js';
import { _clear } from '../src/cache.js';
import { buildMenu, parseWeek, isOpenWeek, normTime, parseBranchList, soldOutSet, buildPhotoIndex, photosFor } from '../src/transform.js';

const ENV = { RISTA_KEY: 'KEY123', RISTA_SECRET: 'SECRET456', DEBUG_TOKEN: 'tok-tok-tok-tok', ALLOWED_ORIGINS: 'https://site.example', CHANNEL: 'Website Pickup' };

// ---- Fake Rista replies, shaped like the official docs. Prices are in on purpose: they must NOT come out.
const CATALOG = {
  taxTypes: [{ taxTypeId: 'tx1', name: 'GST', percentage: 5 }],
  categories: [
    { categoryId: 'c2', name: 'Starters', displayOrder: 2 },
    { categoryId: 'c1', name: 'Biryani', displayOrder: 1, imageURL: 'https://img.example/c1.jpg', subCategories: [{ subCategoryId: 'sc1', name: 'Dum' }] },
  ],
  itemTags: [{ itemTagId: 't1', name: 'Non-Veg' }, { itemTagId: 't2', name: 'Veg' }],
  charges: [{ chargeId: 'ch1', name: 'Packing', chargeRate: 7 }],
  items: [
    { type: 'Simple', itemId: 'i1', skuCode: 'B1H', itemName: 'Chicken Dum Biryani Half', price: 199, categoryId: 'c1', subCategoryId: 'sc1', itemTagIds: ['t1'],
      groupItemId: 'g1', variantValues: [{ name: 'Size', value: 'Half' }], displayOrder: 3, status: 'Active', description: 'Slow cooked',
      extraInfo: { spiceLevel: 'HIGH', preparationTime: 25, serves: 1 } },
    { type: 'Simple', itemId: 'i2', skuCode: 'B1F', itemName: 'Chicken Dum Biryani Full', price: 299, categoryId: 'c1', itemTagIds: ['t1'],
      groupItemId: 'g1', variantValues: [{ name: 'Size', value: 'Full' }], displayOrder: 4, status: 'Active' },
    { type: 'Simple', itemId: 'i3', skuCode: 'B2', itemName: 'Veg Biryani', price: 179, categoryId: 'c1', itemTagIds: ['t2'], displayOrder: 1, status: 'Active' },
    { type: 'Simple', itemId: 'i4', skuCode: 'B3', itemName: 'Old Dish', price: 51, categoryId: 'c1', status: 'Inactive' },
    { type: 'Add On', itemId: 'i5', skuCode: 'X1', itemName: 'Extra Raita', price: 33, categoryId: 'c2', status: 'Active' },
    { type: 'Simple', itemId: 'i6', skuCode: 'S1', itemName: 'Chicken 65', price: 249, categoryId: 'c2', itemTagIds: ['t1'], status: 'Active' },
  ],
  optionSets: [{ optionSetId: 'o1', name: 'Extras', options: [{ optionId: 'op1', itemId: 'i9', optionName: 'Extra Egg', price: 22 }] }],
};

// Fake GET /catalog/enterprise. Has prices on purpose: they must NOT come out.
const ENTERPRISE = {
  items: [{ itemId: 'i3', skuCode: 'B2', prices: [{ channel: 'Website Pickup', price: 777 }] }],
  displayBooks: [
    { name: 'Other outlet', branchCodes: ['SN'], channels: ['Dine In'], items: [
      { itemId: 'i3', imageURL: 'https://img.example/WRONG-veg.jpg' },          // must lose to the Website book
      { itemId: 'i6', imageURL: 'http://insecure.example/x.jpg' },              // not https: rejected
    ] },
    { name: 'Website', branchCodes: ['MR', 'BH'], channels: ['Website Pickup'], items: [
      { itemId: 'i3', imageURL: 'https://img.example/veg.jpg', description: 'x', displayOrder: 1 },
      { itemId: 'i2', imageURL: 'https://img.example/b1f.jpg' },                // only the Full variant has a photo
    ] },
  ],
};

const allDays = (slots) => ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'].map((day) => ({ day, slots }));
const ALL_DAY = [{ startTime: { hh: '00', mm: '00' }, endTime: { hh: '00', mm: '00' } }];

const BRANCHES = [
  { branchCode: 'MR', branchName: 'Moghalrajpuram', status: 'Active', channels: [{ name: 'Dine In' }, { name: 'Website Pickup' }],
    address: { addressLine: '40-7-3 Main Road', city: 'Vijayawada', zip: '520010', latitude: 16.52, longitude: 80.64 } },
  { branchCode: 'SN', branchName: 'Singhnagar', status: 'Active', channels: [{ name: 'Dine In' }], address: { latitude: 16.53, longitude: 80.61 } },
  { branchCode: 'BH', branchName: 'Bhavanipuram', status: 'Inactive', channels: [{ name: 'Website Pickup' }] },
  { branchCode: 'PO', branchName: 'Poranki', status: 'Active', channels: [{ name: 'Dine In' }] },
  { branchCode: 'PL', branchName: 'Patamatalanka', status: 'Active', channels: [] },
  { branchCode: 'AT', branchName: 'Autonagar', status: 'Active', channels: [{ name: 'website pickup' }] },
];

function fakeRista(calls = [], { stockStatus = true, enterprise = true } = {}) {
  return async (url, opts) => {
    const u = new URL(url); calls.push({ path: u.pathname, q: Object.fromEntries(u.searchParams), headers: opts.headers });
    const p = u.pathname.replace('/v1', '');
    const ok = (b) => new Response(JSON.stringify(b), { status: 200 });
    if (p === '/branch/list') return ok(BRANCHES);
    if (p === '/branch') {
      const code = u.searchParams.get('branchCode');
      if (code === 'AT') return ok({ businessHours: { businessDays: allDays([]) } });        // closed all week
      return ok({ businessHours: { businessDays: allDays(ALL_DAY) } });
    }
    if (p === '/catalog') return ok(CATALOG);
    if (p === '/catalog/enterprise') return enterprise ? ok(ENTERPRISE) : new Response('{}', { status: 500 });
    if (p === '/stockStatus') return stockStatus ? ok({ stockOut: ['B1F', 'B2'], stockIn: ['B1H', 'S1'] }) : new Response('{}', { status: 404 });
    if (p === '/items/soldout') return ok({ data: [{ skuCode: 'B2', shortName: 'Veg Biryani' }] });
    return new Response('{}', { status: 404 });
  };
}

const get = (path, headers = {}) => worker.fetch(new Request('https://api.example' + path, { headers }), ENV);

test('JWT is valid HS256 with iss, iat, jti', async () => {
  const t = await signJwt('KEY123', 'SECRET456', 1700000000);
  const [h, p, s] = t.split('.');
  assert.deepEqual(JSON.parse(Buffer.from(h, 'base64url')), { alg: 'HS256', typ: 'JWT' });
  const pl = JSON.parse(Buffer.from(p, 'base64url'));
  assert.equal(pl.iss, 'KEY123'); assert.equal(pl.iat, 1700000000); assert.ok(pl.jti);
  assert.equal(s, createHmac('sha256', 'SECRET456').update(`${h}.${p}`).digest('base64url'));
  const t2 = await signJwt('KEY123', 'SECRET456', 1700000000);
  assert.notEqual(t, t2);
});

test('menu: NO prices, categories by id and order, variants grouped, veg from tags, sold-out from stockStatus', async () => {
  _clear(); globalThis.fetch = fakeRista();
  const r = await get('/api/menu?branch=MR');
  assert.equal(r.status, 200);
  const text = await r.text();
  for (const bad of ['price', 'percentage', 'chargeRate', '199', '299', '179', '249', '777', '"33"', ':22', ':51']) assert.ok(!text.includes(bad), `leaked: ${bad}`);
  const j = JSON.parse(text);
  assert.equal(j.soldOutSource, 'stockStatus');
  assert.deepEqual(j.categories.map((c) => c.name), ['Biryani', 'Starters']);     // sorted by displayOrder, names from categoryId
  assert.equal(j.categories[0].image, 'https://img.example/c1.jpg');
  assert.equal(j.count, 3);                                                        // inactive + add-on skipped, Half/Full = 1 dish
  const [veg, chicken] = j.categories[0].items;
  assert.equal(veg.name, 'Veg Biryani'); assert.equal(veg.veg, true); assert.equal(veg.soldOut, true);   // B2 sold out
  assert.equal(chicken.name, 'Chicken Dum Biryani');                               // "Half" stripped from the name
  assert.equal(chicken.veg, false);
  assert.equal(chicken.subCategory, 'Dum');
  assert.equal(chicken.spice, 'high'); assert.equal(chicken.prepMins, 25); assert.equal(chicken.serves, 1);
  assert.deepEqual(chicken.variants, [{ id: 'B1H', label: 'Half', soldOut: false }, { id: 'B1F', label: 'Full', soldOut: true }]);
  assert.equal(chicken.soldOut, false);                                            // only Full is sold out
  assert.equal(j.categories[1].items[0].name, 'Chicken 65');
});

test('photos: from the display book of this outlet+channel, https only, variant photo used, category fallback', async () => {
  _clear(); globalThis.fetch = fakeRista();
  const j = await (await get('/api/menu?branch=MR')).json();
  assert.equal(j.photosKnown, true);
  assert.equal(j.photoCount, 2);
  const [veg, chicken] = j.categories[0].items;
  assert.equal(veg.image, 'https://img.example/veg.jpg');                      // Website book beats the other outlet's book
  assert.equal(veg.imageSource, 'rista');
  assert.equal(chicken.image, 'https://img.example/b1f.jpg');                  // Half has none, Full has one: dish gets it
  assert.equal(chicken.imageSource, 'rista');
  const c65 = j.categories[1].items[0];
  assert.equal(c65.image, null);                                               // http link rejected, category has no photo
  assert.equal(c65.imageSource, 'none');
});

test('photos: dish with no Rista photo falls back to the category photo', () => {
  const m = buildMenu({ categories: [{ categoryId: 'c', name: 'X', imageURL: 'https://img.example/cat.jpg' }], items: [{ itemId: 'a', skuCode: 'A', itemName: 'Dish', categoryId: 'c' }] }, null, new Map());
  assert.equal(m.categories[0].items[0].image, 'https://img.example/cat.jpg');
  assert.equal(m.categories[0].items[0].imageSource, 'category');
});

test('photos: if the enterprise call fails, menu still works, and Rista is not hammered', async () => {
  _clear(); const calls = []; globalThis.fetch = fakeRista(calls, { enterprise: false });
  const a = await (await get('/api/menu?branch=MR')).json();
  const b = await (await get('/api/menu?branch=BH')).json().catch(() => null);
  assert.equal(a.photosKnown, false); assert.equal(a.photoCount, 0);
  assert.equal(a.count, 3);
  assert.equal(a.categories[0].items[0].imageSource, 'category');
  assert.equal(calls.filter((c) => c.path.endsWith('/catalog/enterprise')).length, 1);   // second request waits (backoff)
  assert.ok(b === null || b.photosKnown === false);
});

test('photos: enterprise reply fetched once for many visitors and many outlets', async () => {
  _clear(); const calls = []; globalThis.fetch = fakeRista(calls);
  await Promise.all(['MR', 'MR', 'SN', 'BH'].map((c) => get('/api/menu?branch=' + c)));
  assert.equal(calls.filter((c) => c.path.endsWith('/catalog/enterprise')).length, 1);
});

test('photo index: only links kept, wrapper tolerated, other outlets used last', () => {
  const idx = buildPhotoIndex({ data: { displayBooks: [
    { branchCodes: ['mr'], channels: ['Web'], items: [{ itemId: 1, imageUrl: 'https://a/1.jpg', price: 5 }, { itemId: 2 }] },
    { branchCodes: [], channels: [], items: [{ itemId: 1, imageURL: 'https://a/ANY.jpg' }, { itemId: 3, imageURL: 'https://a/3.jpg' }] },
  ] } });
  assert.ok(!JSON.stringify(idx).includes('price'));
  assert.equal(idx.length, 2);
  const m = photosFor(idx, 'MR', 'web');
  assert.equal(m.get('1'), 'https://a/1.jpg');      // specific book first
  assert.equal(m.get('3'), 'https://a/3.jpg');
  assert.equal(m.has('2'), false);
  assert.equal(photosFor(idx, 'SN', 'web').get('1'), 'https://a/ANY.jpg');   // generic book for another outlet
  assert.deepEqual(buildPhotoIndex(null), []);
});

test('menu: if stockStatus fails, falls back to /items/soldout', async () => {
  _clear(); globalThis.fetch = fakeRista([], { stockStatus: false });
  const j = await (await get('/api/menu?branch=MR')).json();
  assert.equal(j.soldOutSource, 'soldout');
  assert.equal(j.categories[0].items[0].soldOut, true);
});

test('sends the right headers and params to Rista', async () => {
  _clear(); const calls = []; globalThis.fetch = fakeRista(calls);
  await get('/api/menu?branch=MR');
  const c = calls.find((x) => x.path.endsWith('/catalog'));
  assert.equal(c.headers['x-api-key'], 'KEY123');
  assert.equal(c.headers['x-api-token'].split('.').length, 3);
  assert.deepEqual(c.q, { branch: 'MR', channel: 'Website Pickup' });
  const s = calls.find((x) => x.path.endsWith('/stockStatus'));
  assert.deepEqual(s.q, { branch: 'MR', channel: 'Website Pickup' });
});

test('outlets: channel from branch/list, hours from /branch?branchCode=, lat/lng, address', async () => {
  _clear(); const calls = []; globalThis.fetch = fakeRista(calls);
  const j = await (await get('/api/outlets')).json();
  assert.deepEqual(j.outlets.map((o) => o.code), ['MR', 'SN', 'BH', 'PO', 'PL', 'AT']);
  const by = Object.fromEntries(j.outlets.map((o) => [o.code, o]));
  assert.equal(by.MR.status, 'open');
  assert.equal(by.MR.lat, 16.52); assert.equal(by.MR.lng, 80.64);
  assert.equal(by.MR.address, '40-7-3 Main Road, Vijayawada, 520010');
  assert.equal(by.MR.hours.source, 'rista');
  assert.equal(by.MR.pickup.available, true);
  assert.equal(by.BH.status, 'closed');          // branch Inactive in Rista
  assert.equal(by.SN.status, 'call');            // no Website Pickup channel
  assert.equal(by.PO.status, 'call');
  assert.equal(by.PL.status, 'call');            // empty channel list
  assert.equal(by.AT.status, 'closed');          // channel found (case-insensitive) but no open hours at all
  assert.deepEqual(by.AT.hours.slots, []);
  const h = calls.find((x) => x.path.endsWith('/branch') && x.q.branchCode === 'MR');
  assert.ok(h, 'hours must use branchCode');
  assert.equal(calls.filter((x) => x.path.endsWith('/outlet/status')).length, 0);   // not called without ORDER_SOURCE
});

test('outlets: all unknown if branch/list is down', async () => {
  _clear(); globalThis.fetch = async () => new Response('{}', { status: 500 });
  const j = await (await get('/api/outlets')).json();
  assert.ok(j.outlets.every((o) => o.status === 'unknown'));
});

test('outlets: optional /outlet/status is used only when ORDER_SOURCE is set', async () => {
  _clear(); const calls = [];
  const base = fakeRista(calls);
  globalThis.fetch = async (url, opts) => (new URL(url).pathname.endsWith('/outlet/status') ? (calls.push({ path: '/outlet/status', q: Object.fromEntries(new URL(url).searchParams) }), new Response(JSON.stringify({ status: 'Inactive' }), { status: 200 })) : base(url, opts));
  const res = await worker.fetch(new Request('https://api.example/api/outlets'), { ...ENV, ORDER_SOURCE: 'zomato' });
  const j = await res.json();
  assert.equal(j.outlets.find((o) => o.code === 'MR').status, 'closed');
  assert.equal(calls.find((c) => c.path === '/outlet/status').q.orderSource, 'zomato');
});

test('cache: 5 visitors = 1 call to Rista per path', async () => {
  _clear(); const calls = []; globalThis.fetch = fakeRista(calls);
  await Promise.all([1, 2, 3, 4, 5].map(() => get('/api/menu?branch=MR')));
  assert.equal(calls.filter((c) => c.path.endsWith('/catalog')).length, 1);
  assert.equal(calls.filter((c) => c.path.endsWith('/stockStatus')).length, 1);
});

test('if Rista fails, last good answer is served as stale', async () => {
  _clear(); globalThis.fetch = fakeRista();
  await get('/api/menu?branch=MR');
  const realNow = Date.now; Date.now = () => realNow() + 200 * 1000;
  globalThis.fetch = async () => new Response('{}', { status: 500 });
  const j = await (await get('/api/menu?branch=MR')).json();
  Date.now = realNow;
  assert.equal(j.stale, true); assert.equal(j.count, 3);
});

test('Rista down and nothing cached: 502, no secrets in body', async () => {
  _clear(); globalThis.fetch = async () => new Response('{}', { status: 500 });
  const r = await get('/api/menu?branch=PO');
  assert.equal(r.status, 502);
  const t = await r.text(); assert.ok(!t.includes('KEY123') && !t.includes('SECRET456'));
});

test('bad branch rejected; HO and PA not allowed', async () => {
  for (const b of ['HO', 'PA', 'XX', '']) assert.equal((await get('/api/menu?branch=' + b)).status, 400);
});

test('CORS: only the allowed site', async () => {
  _clear(); globalThis.fetch = fakeRista();
  const ok = await get('/api/health', { Origin: 'https://site.example' });
  assert.equal(ok.headers.get('access-control-allow-origin'), 'https://site.example');
  const no = await get('/api/health', { Origin: 'https://evil.example' });
  assert.equal(no.headers.get('access-control-allow-origin'), null);
});

test('debug: hidden without token, works with token, only listed paths', async () => {
  _clear(); globalThis.fetch = fakeRista();
  assert.equal((await get('/api/debug?path=/catalog&branch=MR')).status, 404);
  assert.equal((await get('/api/debug?token=wrong&path=/catalog')).status, 404);
  assert.equal((await get('/api/debug?token=tok-tok-tok-tok&path=/sale')).status, 400);
  assert.equal((await get('/api/debug?token=tok-tok-tok-tok&path=/catalog&branch=MR&channel=Website%20Pickup')).status, 200);
  assert.equal((await get('/api/debug?token=tok-tok-tok-tok&path=/stockStatus&branch=MR&channel=Website%20Pickup')).status, 200);
  assert.equal((await get('/api/debug?token=tok-tok-tok-tok&path=/branch&branchCode=MR')).status, 200);
  for (const path of ['/catalog/enterprise', '/catalog/item/list']) {
    const r = await get('/api/debug?token=tok-tok-tok-tok&path=' + path);
    assert.notEqual(r.status, 400, path + ' must be an allowed debug path');
  }
});

test('POST is refused (this server never writes to Rista)', async () => {
  const r = await worker.fetch(new Request('https://api.example/api/menu?branch=MR', { method: 'POST' }), ENV);
  assert.equal(r.status, 405);
});

test('hours: Rista businessDays/slots with {hh,mm}, many slots, overnight, closed day', () => {
  assert.equal(normTime('11:00:00'), '11:00'); assert.equal(normTime('2330'), '23:30'); assert.equal(normTime('abc'), null);
  assert.equal(normTime({ hh: '9', mm: '5' }), '09:05'); assert.equal(normTime({ hh: '25', mm: '00' }), null);

  const week = parseWeek({ businessHours: { businessDays: [
    { day: 'Mon', slots: [{ startTime: { hh: '11', mm: '00' }, endTime: { hh: '15', mm: '00' } }, { startTime: { hh: '18', mm: '00' }, endTime: { hh: '02', mm: '00' } }] },
    { day: 'Tue', slots: [] },
  ] } });
  assert.deepEqual(week.mon, [['11:00', '15:00'], ['18:00', '02:00']]);
  assert.deepEqual(week.tue, []); assert.deepEqual(week.wed, []);      // empty / not listed = closed

  const at = (day3, prev3, h, m = 0) => ({ day3, prev3, minutes: h * 60 + m });
  assert.equal(isOpenWeek(week, at('mon', 'sun', 12)), true);
  assert.equal(isOpenWeek(week, at('mon', 'sun', 16)), false);         // between the two slots
  assert.equal(isOpenWeek(week, at('mon', 'sun', 23)), true);          // overnight slot, before midnight
  assert.equal(isOpenWeek(week, at('tue', 'mon', 1)), true);           // overnight slot, after midnight (Monday's)
  assert.equal(isOpenWeek(week, at('tue', 'mon', 3)), false);
  assert.equal(isOpenWeek(week, at('wed', 'tue', 12)), false);
  assert.equal(isOpenWeek(null, at('mon', 'sun', 12)), null);
});

test('hours: unknown time format gives null (fallback hours used), old flat shape still works', () => {
  assert.equal(parseWeek({ businessHours: { businessDays: [{ day: 'Mon', slots: [{ startTime: 'late', endTime: 'later' }] }] } }), null);
  assert.equal(parseWeek({}), null);
  const flat = parseWeek({ timings: [{ from: '11:00', to: '23:30' }] });
  assert.deepEqual(flat.sat, [['11:00', '23:30']]);
});

test('branch list: address parts, channels as objects or strings', () => {
  const b = parseBranchList([{ branchCode: 'zz', status: 'Active', channels: [{ name: 'A' }, 'B'], address: { addressLine: 'X', city: 'Y', landmark: 'Near Z', latitude: 1, longitude: 2 } }]);
  assert.deepEqual(b.ZZ.channels, ['A', 'B']);
  assert.equal(b.ZZ.address, 'X, Near Z, Y');
  assert.equal(parseBranchList([{ branchCode: 'Q' }]).Q.channels, null);
});

test('sold-out sets: stockStatus and items/soldout shapes', () => {
  assert.deepEqual([...soldOutSet({ stockOut: ['A1', 'b2'], stockIn: ['C3'] })].sort(), ['a1', 'b2']);
  assert.ok(soldOutSet({ data: [{ skuCode: 'K1', shortName: 'Tea' }] }).has('k1'));
});

test('works with an old flat catalog too', () => {
  const m = buildMenu([{ itemId: 9, name: 'Tea', categoryName: 'Drinks', rate: 10, variants: [{ name: 'Small' }] }], null);
  assert.equal(m.categories[0].name, 'Drinks'); assert.equal(m.categories[0].items[0].soldOut, false);
  assert.equal(m.categories[0].items[0].variants[0].label, 'Small');
  assert.ok(!JSON.stringify(m).includes('rate'));
});
