RR DURBAR: RESUME PROMPT
READ FULL-PLAN.md FIRST (master plan: scope, phases, PayU, testing). This file is the short version.
SCOPE NOW: Moghalrajpuram (MR) outlet ONLY. Payment: PayU (client account), hosted checkout.
 (updated 15 Oct 2026, payment decided)

HOW TO WORK WITH ME
- Do NOT build anything for Pickup/Rista until I say "build".
- Answer in short, simple lines. I read English as a second language.
- One question at a time, at the end.
- Keep all features (retain or unmask, never trim). No prices on the site, EXCEPT the cart and total (server gives prices, browser never sends them).
- Be honest about what is a guess. Do not waste my energy.

WHAT WE ARE DOING
- RR Durbar website (static HTML, code in GitHub, hosted on Cloudflare Pages). Pickup page shows outlets, open/closed, live dishes, sold-out marks, photos, from Rista.
- DECIDED (15 Oct): API way only. NO DotPe link. Option B: order on our site, then our server sends POST /sale to Rista.
- Channel in Rista (UPDATED 17 Oct): a NEW website channel, "Website" (exact name to confirm from /branch/list). It is NOT linked to DotPe, so test orders do not trigger DotPe messages. The old "DotPe - Pickup" channel is not used and not touched. Test on ONE outlet first.
- First test outlet: Moghalrajpuram (MR). I will test there first.
- Outlets in code: MR, SN, BH, PO, PL, AT. NOT listed: HO (admin) and PA (Patamata closes end Oct 2026).
- SN (Singhnagar), PL (Patamatalanka), AT (Autonagar) have no channel yet: they show "Call to order" until I add it.
- Phone for all outlets: 7702077999. Fallback hours 11:00-23:30 (Autonagar blank).

FILES
- rr-durbar-rista-api-final.zip = Cloudflare Worker v1.2 (this folder). 24 tests pass on FAKE data in the official Rista shape. NOT tested on my real Rista yet. The HTML index file is NOT touched.
- Older zips (WordPress-era, mostly not reused): rr-durbar-v50, rr-durbar-final (2), rr-durbar-final-v16-support.
- Docs inside the zip: PLAN.md (full plan + changes v1.1, v1.2), SETUP.md (my steps), page-example.js (how the page will call the API).

WORKER ROUTES (all GET, read-only; POST is refused)
- /api/health, /api/outlets, /api/menu?branch=MR, /api/debug?token=...&path=... (owner only)
- Debug paths allowed: /branch/list, /branch, /outlet/status, /outlet/delivery/timings, /items/soldout, /stockStatus, /catalog, /catalog/enterprise, /catalog/item/list

RISTA FACTS (swagger: https://ristaapps.com/api/documentation/swagger.json , base https://api.ristaapps.com/v1)
- Headers: x-api-key + x-api-token (new HS256 JWT every call: iss=key, iat, jti). Needs Sales Enterprise + API licence.
- GET /branch/list: address, lat/lng, status, channels[]. GET /branch?branchCode=XX: businessHours.businessDays[].slots[] with {hh,mm}.
- GET /catalog?branch&channel: flat items[] (skuCode, itemId, price, categoryId, groupItemId + variantValues for Half/Full, itemTagIds, status), categories[], itemTags[], optionSets, charges, taxTypes. No dish photo field here. Category has imageURL.
- GET /stockStatus?branch&channel: {stockOut:[sku], stockIn:[sku]} per channel. Backup: GET /items/soldout.
- Dish photos expected in GET /catalog/enterprise > displayBooks[].items[].imageURL (not confirmed with a real reply).
- /outlet/status and /outlet/delivery/timings need orderSource (zomato/swiggy/ownly). Not usable for DotPe. ORDER_SOURCE stays off.
- POST /sale: unique sourceInfo.invoiceNumber, Rista answers 409 on a repeat. GET /sale/online/recent finds missed orders.

WHAT v1.2 DOES
- Outlet status: channel found in /branch/list + branch Active + hours. Words: open / closed / call / unknown.
- Menu: categories by id and order, Half/Full as one dish with variants[{id,label,soldOut}], veg from itemTags, add-ons hidden, sold-out from stockStatus, NO prices.
- Photos: image + imageSource (rista | category | none), photosKnown, photoCount. Page rule: client photo by item.key first, then Rista photo, then category photo, then placeholder.
- Cache 45s (menu 3 min, photos 30 min). If Rista is down, last good answer up to 15 min.

PAYMENT (DECIDED 15 Oct: PayU)
- Rista API cannot collect money from our site (it only records a payment). So we use a payment gateway with the client's OWN merchant account.
- Gateway = PayU (DECIDED 15 Oct). Client account + KYC may still be in progress: ask. Hosted checkout, hash sha512, verify_payment, webhook. Details in FULL-PLAN.md section 7.
- Same PayU account is also used by DotPe: Key/Salt go ONLY into Cloudflare secrets for our Worker. Ask PayU for a separate key/webhook if possible.
- Rules (do not break):
  1. Server works out the amount from Rista prices. Browser never sends prices or totals.
  2. Server creates the gateway order. Customer pays in the gateway's page/popup.
  3. Order is "paid" ONLY when the gateway's server webhook arrives with a valid signature. Never trust the return page.
  4. Only after that: POST /sale to Rista (unique sourceInfo.invoiceNumber), then record the payment in Rista (POST /sale/payments). Never push twice (Rista gives 409 on repeat).
  5. Keep an order store (Cloudflare KV or D1) with state: created > paid > pushed. Retry push max 10 times, then alert me. Check GET /sale/online/recent for missed orders.
  6. Refund: gateway refund API plus reverse in Rista. Rista reverse endpoint is NOT confirmed. Get it confirmed before go-live.
  7. Gateway keys and webhook secret go in Cloudflare secrets only. Test mode end to end first (success, fail, cancel, pending, tab closed after paying).
  8. If the gateway account is not ready, fallback is "pay at pickup" with POST /sale/payments/offline (needs one test at MR).

NOT BUILT YET (Option B)
- Prices/tax/charges in a server-only reply; /api/quote (server total must match Rista bill math); payment; POST /sale push with retry, refund and alert; order store (Cloudflare KV or D1); cart + checkout in the HTML; item schedules (lunch-only dishes).

STILL UNKNOWN / GUESSES
- Real Rista reply shapes (all readers follow the docs). Business days not listed = closed. Add-ons detected only by type "Add On".
- Exact name of the new website channel, whether its menu is filled in Rista, and whether it exists for all outlets or MR only.

MY NEXT STEPS
1. Get/confirm Rista API key + secret. 2. Deploy the Worker (SETUP.md). 3. Open the 6 debug links (SETUP.md step 8) for MR and send the replies (never the key, secret or token). 4. Claude fixes field names in one round. 5. Choose gateway provider and get the client's account and test keys. 6. I say "build": Claude connects the Pickup page, then Option B.

FIRST STEP FOR THE NEW SESSION
Read this. Confirm in 3 short lines what you understood. Ask ONE question: is the PayU account created and is KYC done? Do not build.
