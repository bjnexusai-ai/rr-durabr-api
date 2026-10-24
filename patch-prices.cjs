const fs = require('fs');
let q = fs.readFileSync('src/quote.js', 'utf8'), ix = fs.readFileSync('src/index.js', 'utf8');
if (q.includes('export function pricesFor') && ix.includes("/api/prices")) { console.log('already applied'); process.exit(0); }
const a1 = "import { readRequest, makeQuote } from './quote.js';";
const a2 = "      if (url.pathname === '/api/debug') return debug(env, req, url);";
if (ix.split(a1).length !== 2 || ix.split(a2).length !== 2) { console.log('MARKER NOT FOUND in src/index.js, nothing changed'); process.exit(1); }
if (!q.includes('export function pricesFor')) q += `
// { "<dish id>": <Website price in rupees> } for every dish that has a Website price. Used for the prices on the menu cards.
export function pricesFor(catalogJson) {
  const out = {};
  for (const row of priceIndex(catalogJson).values()) if (row.price !== null && row.id) out[row.id] = row.price;
  return out;
}
`;
ix = ix.replace(a1, () => "import { readRequest, makeQuote, pricesFor } from './quote.js';");
ix = ix.replace(a2, () => `      if (url.pathname === '/api/prices') {
        const code = (url.searchParams.get('branch') || '').toUpperCase();
        if (!OUTLETS.some((o) => o.code === code)) return reply(env, req, { error: 'unknown_branch' }, 400);
        const cat = await loadCatalog(env, code);
        return reply(env, req, { branch: code, prices: pricesFor(cat.value), stale: Boolean(cat.stale), generatedAt: new Date().toISOString() }, 200, 30);
      }
` + a2);
fs.writeFileSync('src/quote.js', q); fs.writeFileSync('src/index.js', ix);
console.log('DONE: GET /api/prices added');
