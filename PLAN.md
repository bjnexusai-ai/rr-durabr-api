# RR Durbar: Rista Pickup API. Detail history
(Master plan = FULL-PLAN.md. Read that first.)
Date: 15 Oct 2026. Version 1.2. Status: code written to the official Rista API docs and tested with fake data (24 tests pass). NOT tested with your real Rista yet.
The HTML file is not touched.

## 1. Goal
Customer opens Order Now > Pickup. Sees outlets. Taps "Nearest" to see distance. Chooses an outlet. Sees that outlet's dishes (live from Rista, no prices, sold-out marked).

## 2. How it works
```
Customer page (Cloudflare Pages)
      |  GET /api/outlets , /api/menu?branch=MR
      v
Cloudflare Worker (this code)   <-- RISTA_KEY, RISTA_SECRET live here only
      |  signs a fresh JWT each call, keeps each answer 45s (menu 3 min)
      |  calls: GET /branch/list, /branch, /catalog, /stockStatus, /catalog/enterprise (photos)
      v
Rista API (api.ristaapps.com/v1)
```
- Page never sees the key. GitHub never has the key.
- Worker only READS from Rista. It cannot create orders. (POST is refused.)
- Only chosen fields are copied. Prices cannot leak.

## 2b. What changed in v1.1 (after reading the Rista API docs)
| # | Was wrong | Now |
|---|---|---|
| 1 | Hours call used `branch=MR` | `GET /branch?branchCode=MR` |
| 2 | Hours reader looked for a plain list | Reads `businessHours.businessDays[].slots[]` with `{hh,mm}` times. Many slots a day, overnight slots, closed days. |
| 3 | Open/closed used `/outlet/status` (needs an aggregator `orderSource`, so every outlet showed "unknown") | Channel is read from `GET /branch/list` (each branch lists its `channels`). Open/closed = branch Active + hours. `/outlet/status` is used only if you set ORDER_SOURCE. |
| 4 | Sold-out used `/items/soldout` (per branch) | `GET /stockStatus` (per branch AND channel). `/items/soldout` is the backup. |
| 5 | All dishes went into one "Menu" group | Dishes use `categoryId`. Names and order come from `categories`. Sub-category added. |
| 6 | Half / Full never showed | Variants are items with one `groupItemId`. They show as ONE dish with `variants:[{id,label,soldOut}]`. |
| 7 | Street missing in address | Uses `addressLine`, `landmark`, `city`, `zip`. |
Also added: veg / non-veg from `itemTags`, add-on items skipped, category photo, spice level, serves, prep time.
Variants are now objects, not words. The page example is updated.

## 2c. What changed in v1.2 (dish photos)
Why: `GET /catalog` has no dish photo field. Photos live in the display book: `GET /catalog/enterprise` > `displayBooks[].items[].imageURL`.
- The menu now also reads the display book. Photos match a dish by `itemId`.
- The display book of THIS outlet and channel wins. Books of other outlets are used last.
- Only `https` links are kept. Prices from that big reply are thrown away at once.
- The photo list is kept 30 min (6 hours if Rista fails). One call serves all 6 outlets.
- If the photo call fails, the menu still works. We wait 2 min before trying again.
- Each dish has `image` and `imageSource`: `rista` (dish photo) | `category` (category photo) | `none`.
- Menu reply also has `photosKnown` and `photoCount`.
- Page rule (later): client photo matched by `item.key` first. Else `item.image` if `imageSource` is `rista`. Else category photo. Else placeholder.
- Two new debug links: `/catalog/enterprise` and `/catalog/item/list`.
Still a guess: the field names (`displayBooks`, `items`, `itemId`, `imageURL`) come from the docs, not from a real reply.

## 3. What is in this folder
| File | Job |
|---|---|
| src/index.js | Routes: health, outlets, menu, debug |
| src/rista.js | Calls Rista with x-api-key + x-api-token |
| src/jwt.js | Makes the JWT (HS256: iss, iat, jti) |
| src/transform.js | Cleans Rista data. Removes prices. Marks sold-out. Open/closed. |
| src/cache.js | Keeps answers. 100 visitors = 1 Rista call. If Rista is down, shows last good answer (max 15 min). |
| src/config.js | The 6 outlets, fallback hours, cache times |
| test/worker.test.mjs | 24 tests (all pass, fake data in the official shape) |
| wrangler.toml | Settings (site address, channel name) |
| page-example.js | How the Pickup page will call this. Reference only. |
| SETUP.md | Steps for you |

## 4. Outlet status words the page gets
- open: the outlet has the channel, the branch is Active in Rista, and now is inside hours
- closed: branch is not Active, or outside hours (or no slots today)
- call: the outlet does not have the channel in Rista yet > show "Call to order"
- unknown: Rista could not be reached, or did not list channels > show "Call to order"

## 5. What the old files (v14 and v16 zips) told us
Those zips were a WordPress plan. Today's site is static HTML, so the PHP is not reused. But:

USEFUL
1. Phone for all outlets: 7702077999. Hours in old kit: 11:00-23:30. Autonagar hours were blank. (Used only as fallback.)
2. No outlet ever had lat/lng in the old data. We take it from Rista GET /branch/list. If Rista has none, type it in config.js.
3. Old plan names one more Rista endpoint: GET /outlet/delivery/timings (pickup timings). Might be a better hours source than GET /branch. Added to the debug tool so we can look.
4. Old plan warns: the catalog "variant" shape (Half / Full) was never confirmed. Same risk now. We read it in a flexible way and check with the debug link.
5. Old plan: Rista photos are not guaranteed. Same here. Item gets `key` so you can match your 31 photos.
6. Rules to keep IF you later take orders on the site (Option B): send each sale once only (no double orders), retry max 10 times, record payment only after the payment gateway confirms from its server (never from the return page). Old code did this in PHP. B would need a small database (Cloudflare KV or D1) for this.

CONFLICT (I trust the newer facts)
- Old PHP used header `Authorization: Bearer <jwt>` and an `exp` claim. Your notes say Rista needs `x-api-key` + `x-api-token` and payload iss/iat/jti. This code follows your notes. Old PHP never ran against real Rista, and its own comment says "fill in per official docs".

NOT NEEDED NOW
- Order Board, WooCommerce, PayU, loyalty points, refund endpoint (unconfirmed in old files). Only for Option B, later.

## 6. What I am NOT sure about (honest list)
1. Real replies. Shapes now follow the docs, but no real reply has been seen. One round with the debug links fixes any miss.
2. The exact channel name. Check `channels` in the /branch/list reply. Set CHANNEL to match.
3. Business days: a day that is not listed is treated as CLOSED. If Rista lists only some days, the debug reply will show it.
4. Add-ons: items with type "Add On" are hidden. If Rista marks add-ons another way, a few extras may show as dishes.
5. Item schedules (`scheduleIds`, example lunch-only dishes) are NOT applied yet. Fine for display. Needed for Option B.
6. Dish photos: expected in the display book (v1.2). Not confirmed until the real reply is seen. Client photos are matched by `item.key`.
7. Rate limits: unknown. Cache protects us.
8. Cache is per Cloudflare server (in memory). Fine for one restaurant. If traffic grows, move to KV.

## 7. Decisions still open
1. Channel: UPDATED 17 Oct. New website channel "Website" created in Rista. Not DotPe-linked, so the DotPe risk is gone. Confirm exact name.
2. Singhnagar, Patamatalanka, Autonagar: until the channel is added they show "Call to order".
3. DECIDED 15 Oct: API way only, no DotPe link = Option B (order on our site). Channel: "Website" (new, 17 Oct). First test outlet: MR.
4. Cloudflare Pages address (for CORS in wrangler.toml).
5. Payment: gateway (Razorpay etc., client keys) or "pay at pickup" via POST /sale/payments/offline. Rista API cannot collect money from our site. OPEN.

## 7b. If you choose Option B (not built)
Keep: JWT, Rista call, cache, outlets, menu, debug. Add:
- Prices, `taxTypeIds`, `chargeIds`, option prices in a server-only reply. The page never sends a price.
- `/api/quote`: server computes the total. It must match the Rista bill math.
- Payment create and webhook (gateway confirms from its server).
- `POST /sale` with a unique `sourceInfo.invoiceNumber`. Rista answers 409 on a repeat. Send once only.
- `GET /sale/online/recent` to find orders that were missed.
- A small database (Cloudflare KV or D1) for order records, retry, refund.
- Apply item schedules and sold-out check again just before the sale.

## 8. Order of work
1. You: get API key + secret in Rista (Access menu).
2. You: Cloudflare account, deploy Worker (SETUP.md).
3. You: open the 4 debug links in SETUP.md step 8, send me the raw replies (remove nothing; do NOT send key, secret or token).
4. Me: fix field names in one round.
5. You say "build": I connect the Pickup page (HTML) to the API.
6. Test at 390 / 820 / 1280 / 1440. Real phone test by you.
