// Turns raw Rista replies into SAFE data for the website.
// Rule: we copy only fields we choose (a whitelist). Prices are never copied.
// Shapes follow the official Rista Platform API docs (GET /branch/list, /branch, /catalog, /stockStatus).
// Readers are still tolerant (a few extra field names) because no real reply has been seen yet.

const lc = (s) => String(s ?? '').trim().toLowerCase();
const num = (v) => (v === null || v === undefined || v === '' || Number.isNaN(Number(v)) ? null : Number(v));
const str = (...vals) => { for (const v of vals) if (typeof v === 'string' && v.trim()) return v.trim(); return ''; };
const idOf = (v) => (typeof v === 'number' ? String(v) : typeof v === 'string' ? v.trim() : '');
const asList = (v) => (Array.isArray(v) ? v.filter((x) => x && typeof x === 'object') : []);
const httpsUrl = (v) => (typeof v === 'string' && /^https:\/\//i.test(v.trim()) ? v.trim() : null);
const cmp = (a, b) => (a === b ? 0 : a < b ? -1 : 1);
const pad = (n) => String(n).padStart(2, '0');

export const sameName = (a, b) => lc(a) !== '' && lc(a) === lc(b);

export function asArray(j) {
  if (Array.isArray(j)) return j;
  if (j && typeof j === 'object') {
    for (const k of ['data', 'items', 'branches', 'outlets', 'result', 'results', 'list', 'records']) {
      if (Array.isArray(j[k])) return j[k];
    }
  }
  return [];
}

/* ---------- branches: GET /branch/list ---------- */
const chanName = (c) => (typeof c === 'string' ? c.trim() : str(c?.name, c?.channelName));

export function parseBranchList(json) {
  const out = {};
  for (const b of asArray(json)) {
    const code = str(b.branchCode, b.code, b.branch_code).toUpperCase();
    if (!code) continue;
    const a = b.address && typeof b.address === 'object' ? b.address : {};
    const parts = [a.addressLine, a.addressLine1, a.addressLine2, a.street, a.landmark, a.locality, a.city, a.zip, a.zipCode, a.pincode]
      .filter((x) => typeof x === 'string' && x.trim()).map((x) => x.trim());
    out[code] = {
      name: str(b.branchName, b.name),
      active: lc(b.status) ? lc(b.status) === 'active' : null,
      lat: num(a.latitude ?? a.lat ?? b.latitude),
      lng: num(a.longitude ?? a.lng ?? a.lon ?? b.longitude),
      address: [...new Set(parts)].join(', ') || (typeof b.address === 'string' ? b.address : ''),
      // names of the channels this branch has. null = Rista did not say.
      channels: Array.isArray(b.channels) ? b.channels.map(chanName).filter(Boolean) : null,
    };
  }
  return out;
}

/* ---------- optional: GET /outlet/status (needs an aggregator "orderSource") ---------- */
export function parseOutletStatus(json) {
  const rows = asArray(json);
  if (!rows.length && json && typeof json === 'object' && !Array.isArray(json) && (json.status || json.isActive !== undefined)) rows.push(json);
  const isOn = (r) => r.isActive === true || lc(r.status ?? r.state) === 'active';
  return { channelFound: rows.length > 0, active: rows.some(isOn) };
}

/* ---------- business hours: GET /branch -> businessHours.businessDays[].slots[] ---------- */
const D3 = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];
const day3 = (s) => lc(s).slice(0, 3);

export function normTime(v) {
  if (v && typeof v === 'object' && !Array.isArray(v)) {            // Rista style { hh: "11", mm: "00" }
    const h = num(v.hh ?? v.hour), m = num(v.mm ?? v.min ?? v.minute) ?? 0;
    return h !== null && h >= 0 && h <= 24 && m >= 0 && m < 60 ? `${pad(h)}:${pad(m)}` : null;
  }
  if (typeof v !== 'string' && typeof v !== 'number') return null;
  const s = String(v).trim();
  const m = s.match(/^(\d{1,2}):(\d{2})(?::\d{2})?$/) || s.match(/^(\d{2})(\d{2})$/);
  if (!m) return null;
  const h = +m[1], mi = +m[2];
  return h <= 24 && mi < 60 ? `${pad(h)}:${pad(mi)}` : null;
}

const slotOf = (s) => [
  normTime(s.startTime ?? s.open ?? s.from ?? s.start ?? s.openTime),
  normTime(s.endTime ?? s.close ?? s.to ?? s.end ?? s.closeTime),
];

// Returns { mon:[['11:00','23:30']], tue:[...], ... } or null if the format is not understood.
// A day with no slots = closed that day. A day not listed at all = closed too.
export function parseWeek(json) {
  const root = Array.isArray(json) ? json[0] : json;
  if (!root || typeof root !== 'object') return null;
  let days = null;
  const bh = root.businessHours;
  if (bh && Array.isArray(bh.businessDays)) days = bh.businessDays;
  else for (const k of ['businessHours', 'timings', 'hours', 'businessTimings', 'operatingHours']) {
    if (Array.isArray(root[k])) { days = root[k]; break; }
  }
  days = asList(days);
  if (!days.length) return null;

  const week = {};
  for (const e of days) {
    const d = day3(e.day ?? e.dayOfWeek ?? e.weekday);
    if (!D3.includes(d)) continue;
    const raw = Array.isArray(e.slots) ? e.slots : [e];
    const slots = raw.filter((s) => s && typeof s === 'object').map(slotOf).filter(([o, c]) => o && c);
    if (raw.length && !slots.length) return null;      // times in a format we do not know: use fallback instead of guessing
    week[d] = (week[d] || []).concat(slots);
  }
  if (!Object.keys(week).length) {                      // old flat shape: one entry, no day name = same every day
    const [o, c] = slotOf(days[0]);
    if (!o || !c) return null;
    for (const d of D3) week[d] = [[o, c]];
  }
  for (const d of D3) if (!week[d]) week[d] = [];
  return week;
}

export const weekFromRange = (range) => (range ? Object.fromEntries(D3.map((d) => [d, [range]])) : null);

export function istNow(date = new Date()) {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Asia/Kolkata', hour: '2-digit', minute: '2-digit', hour12: false, weekday: 'long',
  }).formatToParts(date);
  const get = (t) => parts.find((p) => p.type === t)?.value;
  const h = +get('hour') % 24;
  const dayName = get('weekday');
  const i = Math.max(0, D3.indexOf(day3(dayName)));
  return { minutes: h * 60 + +get('minute'), dayName, day3: D3[i], prev3: D3[(i + 6) % 7] };
}

const toMin = (t) => { const [h, m] = t.split(':').map(Number); return h * 60 + m; };

// true / false, or null when we have no hours at all
export function isOpenWeek(week, now) {
  if (!week) return null;
  const m = now.minutes;
  for (const [a, b] of week[now.day3] || []) {
    const o = toMin(a), c = toMin(b);
    if (o === c) return true;                                 // 24 hours
    if (o < c ? m >= o && m < c : m >= o) return true;        // overnight slot: today's part
  }
  for (const [a, b] of week[now.prev3] || []) {               // overnight slot from yesterday: after midnight part
    const o = toMin(a), c = toMin(b);
    if (o > c && m < c) return true;
  }
  return false;
}

export function hoursView(week, now, source) {
  if (!week) return null;
  const slots = (week[now.day3] || []).map(([open, close]) => ({ open, close }));
  return { open: slots[0]?.open ?? null, close: slots[slots.length - 1]?.close ?? null, slots, source };
}

/* ---------- menu: GET /catalog ---------- */
const ID_KEYS = ['skuCode', 'sku', 'itemId', 'itemCode', 'id'];
const NAME_KEYS = ['itemName', 'name', 'title'];
const CHILD_KEYS = ['items', 'products', 'skus', 'categories', 'subCategories', 'menu'];

const itemId = (o) => str(...ID_KEYS.map((k) => (typeof o[k] === 'number' ? String(o[k]) : o[k])));
const itemName = (o) => str(...NAME_KEYS.map((k) => o[k]));
const hasChildren = (o) => CHILD_KEYS.some((k) => Array.isArray(o[k]) && o[k].some((x) => x && typeof x === 'object'));
const looksLikeItem = (o) => itemName(o) && itemId(o) && !hasChildren(o);

// Rista has no veg field. Veg / non-veg comes from item tags (itemTags).
function vegFromTags(ids, tagMap) {
  const names = (Array.isArray(ids) ? ids : []).map((i) => lc(tagMap.get(idOf(i)))).filter(Boolean);
  if (names.some((n) => /non[\s-]?veg|\begg|meat|chicken|mutton|fish|prawn|seafood/.test(n))) return false;
  if (names.some((n) => /veg/.test(n))) return true;
  return null;
}

function vegFlag(o) {
  if (typeof o.isVeg === 'boolean') return o.isVeg;
  const t = lc(o.itemType ?? o.foodType ?? o.type ?? o.dietType);
  if (!t) return null;
  if (t.includes('non') || t.includes('egg')) return false;
  if (t.includes('veg')) return true;
  return null;
}

function imageOf(o) {
  const c = [o.imageUrl, o.imageURL, o.image, o.photo, Array.isArray(o.images) ? o.images[0] : null];
  for (const v of c) {
    const u = httpsUrl(typeof v === 'string' ? v : v && typeof v === 'object' ? v.url : '');
    if (u) return u;
  }
  return null;
}

// old / flat shape only: variants listed inside one item
function legacyVariants(o) {
  const arr = ['variants', 'skus', 'options', 'sizes'].map((k) => o[k]).find(Array.isArray) || [];
  return arr.map((v) => str(v?.variantName, v?.name, v?.size, v?.label)).filter(Boolean).slice(0, 8);
}

// "Chicken Biryani Half" + label "Half"  ->  "Chicken Biryani"
function stripVariant(name, label) {
  if (!label) return name;
  const esc = label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const out = name.replace(new RegExp(`\\s*[-–(\\[]?\\s*${esc}\\s*[)\\]]?\\s*$`, 'i'), '').trim();
  return out || name;
}

export function extractItems(catalogJson) {
  const found = [];
  const walk = (node, category) => {
    if (Array.isArray(node)) { node.forEach((n) => walk(n, category)); return; }
    if (!node || typeof node !== 'object') return;
    if (looksLikeItem(node)) { found.push({ node, category: str(node.categoryName, node.category, category) }); return; }
    const here = itemName(node) || category;
    for (const k of Object.keys(node)) if (node[k] && typeof node[k] === 'object') walk(node[k], here);
  };
  walk(catalogJson, '');
  return found;
}

// stockStatus reply: { stockOut:[sku,...], stockIn:[...] }.  items/soldout reply: { data:[{skuCode,...}] }.
export function soldOutSet(json) {
  const set = new Set();
  const add = (v) => { if (v !== null && v !== undefined && String(v).trim()) set.add(lc(v)); };
  const rows = json && !Array.isArray(json) && Array.isArray(json.stockOut) ? json.stockOut : asArray(json);
  for (const r of rows) {
    if (r && typeof r === 'object') { [...ID_KEYS, ...NAME_KEYS, 'shortName', 'longName'].forEach((k) => add(r[k])); }
    else add(r);
  }
  return set;
}

/* ---------- dish photos: GET /catalog/enterprise -> displayBooks[].items[].imageURL ---------- */
// Keeps ONLY photo links (never prices). Small enough to cache.
// Returns [{ branchCodes:[CODE], channels:[lowercase], items:[[idLower, https-url], ...] }]
export function buildPhotoIndex(json) {
  const root = json && typeof json === 'object' && !Array.isArray(json) ? json : {};
  const books = asList(root.displayBooks ?? root.data?.displayBooks);
  const out = [];
  for (const b of books) {
    const items = [];
    for (const it of asList(b.items)) {
      const id = idOf(it.itemId) || idOf(it.skuCode) || idOf(it.sku);
      const url = httpsUrl(it.imageURL ?? it.imageUrl ?? it.image);
      if (id && url) items.push([lc(id), url]);
    }
    if (!items.length) continue;
    out.push({
      branchCodes: (Array.isArray(b.branchCodes) ? b.branchCodes : []).map((x) => String(x).trim().toUpperCase()).filter(Boolean),
      channels: (Array.isArray(b.channels) ? b.channels : []).map((x) => lc(x)).filter(Boolean),
      items,
    });
  }
  return out;
}

// Photos for ONE outlet + channel. Books that belong to this outlet and channel win.
// Books for other outlets are used last (a dish photo is the same dish photo).
export function photosFor(index, code, channel) {
  const map = new Map();
  const me = String(code).toUpperCase(), ch = lc(channel);
  const rank = (b) => {
    const branchOk = !b.branchCodes.length || b.branchCodes.includes(me);
    const chanOk = !b.channels.length || b.channels.includes(ch);
    if (!branchOk || !chanOk) return -1;
    return (b.branchCodes.length ? 1 : 0) + (b.channels.length ? 1 : 0);   // most specific first
  };
  const ordered = [...(index || [])].map((b, i) => ({ b, r: rank(b), i }))
    .sort((x, y) => cmp(y.r, x.r) || cmp(x.i, y.i));
  for (const { b } of ordered) for (const [id, url] of b.items) if (!map.has(id)) map.set(id, url);
  return map;
}

export function buildMenu(catalogJson, sold, photos = null) {
  const root = catalogJson && typeof catalogJson === 'object' && !Array.isArray(catalogJson) ? catalogJson : {};
  const docShape = Array.isArray(root.items);          // real Rista shape: flat items[] + separate categories[]
  const cats = new Map(), subs = new Map(), tags = new Map();

  if (docShape) {
    for (const c of asList(root.categories)) {
      const id = idOf(c.categoryId);
      if (!id) continue;
      cats.set(id, { name: str(c.name, c.categoryName), order: num(c.displayOrder), image: httpsUrl(c.imageURL ?? c.imageUrl) });
      for (const s of asList(c.subCategories)) { const sid = idOf(s.subCategoryId); if (sid) subs.set(sid, str(s.name)); }
    }
    for (const t of asList(root.itemTags)) { const id = idOf(t.itemTagId); if (id) tags.set(id, str(t.name)); }
  }

  const raw = docShape ? asList(root.items).map((node) => ({ node, category: '' })) : extractItems(catalogJson);

  const members = [];
  const seen = new Set();
  raw.forEach(({ node, category }, index) => {
    const status = lc(node.status);
    if (node.isActive === false || node.isDeleted === true || status.includes('inactive') || status.includes('delet') || status.includes('disab')) return;
    if (/add[\s-]?on/.test(lc(node.type))) return;      // add-ons are extras, not dishes
    const id = itemId(node), name = itemName(node);
    if (!id || !name || seen.has(id)) return;
    seen.add(id);
    const c = cats.get(idOf(node.categoryId));
    members.push({
      node, id, name, index,
      label: asList(node.variantValues).map((v) => str(v.value)).filter(Boolean).join(' '),
      group: idOf(node.groupItemId),
      category: c?.name || str(node.categoryName, node.category, category) || 'Menu',
      catOrder: c?.order ?? null,
      catImage: c?.image ?? null,
      sub: subs.get(idOf(node.subCategoryId)) || '',
      order: num(node.displayOrder),
      sold: sold ? [id, str(node.skuCode), str(node.sku), str(node.itemId), name].some((v) => v && sold.has(lc(v))) : false,
      photo: imageOf(node) || (photos ? [node.itemId, node.skuCode, node.sku, id].map(idOf).filter(Boolean).map((k) => photos.get(lc(k))).find(Boolean) || null : null),
    });
  });

  // Variants (Half / Full) are separate items that share one groupItemId. Show them as ONE dish.
  const groups = new Map();
  for (const m of members) {
    const k = m.group ? `g:${m.group}` : `i:${m.id}`;
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push(m);
  }

  const dishes = [];
  for (const g of groups.values()) {
    g.sort((a, b) => cmp(a.order ?? Infinity, b.order ?? Infinity) || cmp(a.index, b.index));
    const first = g[0];
    const multi = g.length > 1;
    const x = first.node.extraInfo && typeof first.node.extraInfo === 'object' ? first.node.extraInfo : {};
    const spice = lc(x.spiceLevel);
    const own = g.map((m) => m.photo).find(Boolean) || null;      // a dish photo from Rista (any variant)
    dishes.push({
      order: first.order, index: first.index,
      category: first.category, catOrder: first.catOrder, catImage: first.catImage,
      item: {
        id: first.id,
        name: multi ? stripVariant(first.name, first.label) : first.name,
        key: (multi ? stripVariant(first.name, first.label) : first.name).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, ''), // for matching local photos
        description: str(...g.flatMap((m) => [m.node.description, m.node.itemDescription])),
        subCategory: first.sub,
        veg: vegFromTags(first.node.itemTagIds, tags) ?? vegFlag(first.node),
        image: own || first.catImage || null,
        imageSource: own ? 'rista' : first.catImage ? 'category' : 'none',   // client photos are matched on the page by item.key
        spice: spice && spice !== 'nonspicy' ? spice : null,
        serves: num(x.serves),
        prepMins: num(x.preparationTime),
        variants: multi
          ? g.map((m) => ({ id: m.id, label: m.label || m.name, soldOut: m.sold }))
          : legacyVariants(first.node).map((label) => ({ id: first.id, label, soldOut: first.sold })),
        soldOut: multi ? g.every((m) => m.sold) : first.sold,
      },
    });
  }

  const catMap = new Map();
  for (const d of dishes) {
    if (!catMap.has(d.category)) catMap.set(d.category, { name: d.category, order: d.catOrder ?? Infinity, seq: catMap.size, image: d.catImage, items: [] });
    const c = catMap.get(d.category);
    if (d.catOrder !== null && d.catOrder < c.order) c.order = d.catOrder;
    if (!c.image && d.catImage) c.image = d.catImage;
    c.items.push(d);
  }
  const categories = [...catMap.values()]
    .sort((a, b) => cmp(a.order, b.order) || cmp(a.seq, b.seq))
    .map((c) => ({
      name: c.name,
      image: c.image,    // category photo from Rista (may be null). Dish photos: match item.key to your local photos.
      items: c.items.sort((a, b) => cmp(a.order ?? Infinity, b.order ?? Infinity) || cmp(a.index, b.index)).map((d) => d.item),
    }));
  return { categories, count: categories.reduce((n, c) => n + c.items.length, 0) };
}
