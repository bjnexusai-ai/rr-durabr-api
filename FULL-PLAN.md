# RR DURBAR: FULL PLAN (START HERE)
Version: final-3. Date: 15 Oct 2026.
Checked: code + 24 tests re-run today (all pass, FAKE data). PayU formulas checked against docs.payu.in today. Rista shapes: from the official Rista swagger, NOT yet seen on the real account.

Any new session: read THIS file first, then RESUME-PROMPT.md. Do not build until the owner says "build".

---------------------------------------------------------------
## 1. The plan in 6 lines
1. Static website (HTML on Cloudflare Pages, code in GitHub) + one small Cloudflare Worker (this folder).
2. Worker talks to Rista (menu, outlet open/closed, sold-out, photos, later: create order).
3. Worker talks to PayU (payment). Worker is the ONLY place that holds secrets.
4. No DotPe link. Customer orders on our site (Option B).
5. NOW: Moghalrajpuram (MR) only. Other outlets later.
6. Money rule: an order goes to Rista ONLY after PayU confirms payment from its server.

---------------------------------------------------------------
## 2. Scope: what "MR only" means
- Pickup page can list all 6 outlets (MR, SN, BH, PO, PL, AT). Not listed: HO (admin) and PA (closes end Oct 2026).
- ONLY MR can take an order. Plan: a setting `ORDER_ENABLED_BRANCHES = "MR"`. Every other outlet shows "Call to order", even if its channel exists. We add outlets one by one later by editing this setting.
- Rista channel (UPDATED 17 Oct): new website channel "Website" (exact name to confirm). Not linked to DotPe, so no DotPe messages on a test sale. First test = one order at MR, owner watching.
- SN, PL, AT have no channel in Rista yet. They show "Call to order" until the owner adds it.
- Phone: 7702077999. Fallback hours 11:00-23:30 (Autonagar blank). Used only if Rista gives no hours.
- Site rule: no prices anywhere, EXCEPT cart and total. The server gives prices. The browser never sends a price or a total.

---------------------------------------------------------------
## 3. Architecture
```
Customer phone / PC
  |  Page: Cloudflare Pages (static HTML)                  [no secrets]
  |
  |-- GET  /api/outlets, /api/menu?branch=MR             (built)
  |-- POST /api/quote      server totals the cart        (NOT built)
  |-- POST /api/order      makes order + PayU fields     (NOT built)
  |-- POST /api/pay/return PayU sends browser back       (NOT built)
  |-- POST /api/pay/webhook PayU server tells us "paid"  (NOT built)
  |-- GET  /api/order/status?id=..&t=..  page polls      (NOT built)
  v
Cloudflare Worker  [secrets: RISTA_KEY, RISTA_SECRET, PAYU_KEY, PAYU_SALT, DEBUG_TOKEN]
  |-- Rista API  api.ristaapps.com/v1   (JWT each call)
  |-- PayU       secure.payu.in (live) / test.payu.in (test)
  |-- Order store: Cloudflare KV or D1                    (NOT built)
```

---------------------------------------------------------------
## 4. Status board
BUILT and tested on FAKE data (v1.2, 24 tests):
- JWT for Rista (HS256: iss, iat, jti), headers x-api-key + x-api-token.
- /api/outlets: open / closed / call / unknown (channel from /branch/list, status + hours from /branch).
- /api/menu: categories, Half/Full variants, veg tag, sold-out (/stockStatus), photos (category + display book), NO prices.
- Cache 45s (menu 3 min, photos 30 min), last-good answer if Rista is down. Debug route (owner only). Read-only (POST refused).

NOT BUILT (Option B and PayU):
- Server-only prices, tax, charges. /api/quote.
- PayU: hash, order create, return, webhook, verify, refund.
- POST /sale to Rista, payment record, retry, missed-order check, order store.
- Order-enabled setting for MR only.
- Cart + checkout + order-status screen in the HTML. Pickup page connection (HTML not touched yet).
- Item schedules (lunch-only dishes).

UNKNOWN (need real data or a test):
- Real Rista reply shapes (all readers follow the docs).
- Exact channel name text. Where dish photos really are. Whether Rista has any rate limit.
- Exact name of the new website channel; whether its menu is filled; whether it exists for all outlets or MR only.
- Rista payment-record and reverse (refund) fields. Not confirmed.
- Whether this PayU account can have its own webhook URL and test keys (DotPe also uses it). Ask PayU.

---------------------------------------------------------------
## 5. Implementation method (phases). Do in order. Each phase has "DONE WHEN".
Rule: one phase at a time. Test at MR only. Owner says "build" before each build phase.

**Phase 0. Prerequisites (owner)**
- Rista: API licence + Sales Enterprise active. API key + secret created (Access menu).
- PayU: account created, KYC finished (see section 7). Our website address added. Test key + salt available.
- Cloudflare account. GitHub repo for this folder (private).
- DONE WHEN: owner confirms all four.

**Phase 1. Deploy read-only Worker and look at REAL data (owner + Claude)**
- Follow SETUP.md. Set secrets. Deploy. Open the 6 debug links (SETUP.md step 8) for MR. Send replies (never key, secret, token).
- Claude fixes field names in ONE round. Re-run tests with the real shapes copied in.
- DONE WHEN: /api/outlets shows MR "open" or "closed" correctly; /api/menu?branch=MR shows right dishes, Half/Full, sold-out, photos where Rista has them, no prices.

**Phase 2. Connect the Pickup page to the read-only API (Claude, HTML change)**
- Outlet cards, open/closed, "Nearest" distance (only when customer taps it), menu for the chosen outlet. Photo order: client photo by item.key > Rista dish photo > category photo > placeholder.
- No order button yet (or button disabled). Test 390 / 820 / 1280 / 1440 + real phone.
- DONE WHEN: menu on our site matches Rista for MR; turning MR off in Rista shows "Closed" within about 1 minute; marking a dish sold out shows it within about 1 minute.

**Phase 3. Server prices and /api/quote (Claude)**
- Worker keeps price, tax, charges, option prices in a server-only reply. Quote = server total. Must equal the Rista bill math for the same cart (test with 3 real carts at MR against the Rista bill).
- DONE WHEN: 3 test carts: our total = Rista total to the paisa.

**Phase 4. PayU in TEST mode only (Claude + owner)**
- Order create + hash, return, webhook, verify_payment, order store. No Rista push yet.
- DONE WHEN: all 7 payment tests pass in test mode (section 8, table P).

**Phase 5. Rista sale push (one order, MR, owner watching)**
- After "paid" (webhook + verify OK): POST /sale with unique sourceInfo.invoiceNumber, then record the payment. Check the order on the MR Rista screen. (No DotPe link now.)
- DONE WHEN: one test order shows correctly in Rista (items, qty, pickup, paid), no double order.

**Phase 6. Failure handling**
- Retry (max 10), alert to owner, missed-order check with GET /sale/online/recent, refund path (PayU refund + Rista reverse), sold-out re-check just before the sale.
- DONE WHEN: failure drills pass (section 8, table F).

**Phase 7. Go-live at MR**
- Switch PayU to LIVE key + salt, live URLs, live webhook. One real small order, then refund it. Owner watches the first real day.
- DONE WHEN: go-live checklist (section 8) all ticked.

**Phase 8. Other outlets**
- Owner adds the channel in Rista for SN, PL, AT (and checks BH, PO). Add the code to ORDER_ENABLED_BRANCHES. Repeat Phase 5 test at each outlet.

---------------------------------------------------------------
## 6. Order flow and states
1. Customer picks outlet + dishes. Page sends item ids + quantities + options ONLY (no prices).
2. /api/quote: Worker re-checks outlet open, dish not sold out, schedule, then computes total.
3. /api/order: Worker saves order state CREATED (our order id, items, total, customer name/phone/email). Makes txnid. Returns PayU form fields + hash (never the salt).
4. Page POSTs the form to PayU. Customer pays on PayU's page.
5. PayU server calls webhook. Worker checks hash AND calls verify_payment. If OK and amount matches: state PAID.
6. Worker sends POST /sale to Rista. If OK: state PUSHED. Then records the payment in Rista.
7. Browser returns to our site. Page polls /api/order/status and shows "Order placed" only when PAID (better: PUSHED).
8. If push fails: state stays PAID, retry (max 10), then DEAD + email/alert to owner. Customer is told "Payment received, we are confirming" and the owner calls them.
9. Money taken but cannot be fulfilled: refund through PayU.
States: CREATED > PAID > PUSHED. Side states: FAILED (payment failed), DEAD (push failed 10x), REFUNDED.
Rules: PUSHED can never be pushed again. invoiceNumber is unique per order (Rista gives 409 on repeat = treat as "already pushed", look it up, do not create again).

---------------------------------------------------------------
## 7. PayU integration (full clarity)

### 7a. Account (owner, client side)
Source: PayU onboarding note from DotPe.
- Register: https://u.payu.in/2IJbFqoNEK8f . Email + password, mobile OTP, profile.
- Documents: PAN, address proof (Voter ID / Passport / Driving Licence), cancelled cheque or bank statement, bank details, Aadhaar.
- Dashboard > "Activate Account": PAN check, business details (category, monthly sales), bank check, Payment Collection = "Website" + website URL, Aadhaar OTP, e-sign by OTP to email, Submit. KYC done = account active.
- Keys: Developer tab > API Keys > "Key Salt Details": Merchant Key, Merchant Salt. MID: Profile (top right).
- DotPe's note says to give Key + Salt + MID to the DotPe team. That is for DotPe's own link. We do NOT need DotPe for our flow.

### 7b. Two uses of one PayU account (important)
- DotPe's takeaway link uses the account (Key/Salt/MID given to DotPe).
- Our site uses the same account: Key + Salt go ONLY into Cloudflare secrets (PAYU_KEY, PAYU_SALT).
- Risks: (1) If the Salt is rotated, BOTH break. (2) PayU needs our website address approved, not only the DotPe link. (3) Our payments appear in the same PayU dashboard.
- Ask PayU: can we have a separate key/salt or a second merchant for our site? Can we set our own webhook URL? Can we get TEST key/salt?

### 7c. Method: PayU Hosted Checkout (customer pays on PayU's page)
Why: we never touch card data. Smallest security burden.
- Test URL: https://test.payu.in/_payment . Live URL: https://secure.payu.in/_payment .
- Browser form POST fields: key, txnid, amount (2 decimals, like 349.00), productinfo, firstname, email, phone, surl, furl, hash, udf1 (our order id), + optional udf2..5.
- surl/furl = our Worker return URL (browser comes back here).
- Request hash (from PayU docs):
  `sha512(key|txnid|amount|productinfo|firstname|email|udf1|udf2|udf3|udf4|udf5||||||SALT)`
  Empty udf = empty between the pipes. The string must match what we post EXACTLY.
- Response (reverse) hash to check on return AND webhook:
  `sha512(SALT|status||||||udf5|udf4|udf3|udf2|udf1|email|firstname|productinfo|amount|txnid|key)`
  (If PayU sends additional_charges, it goes first in the reverse string. Check the exact response first.)
- Server check (the real proof): Verify Payment API.
  POST https://info.payu.in/merchant/postservice.php?form=2 (live). Test: https://test.payu.in/merchant/postservice?form=2
  Form fields: key, command=verify_payment, var1=<txnid>, hash=`sha512(key|command|var1|SALT)`.
  Rule: mark PAID only if status = success AND amount = our stored amount AND txnid is ours AND not already PAID.
- Webhook: PayU can call our server directly (S2S). Set the webhook URL in the PayU dashboard. Handle it the same way as return: check hash, call verify_payment, then update state. Webhook can arrive twice or before the browser: the code must be safe to run twice.
- Refund: command `cancel_refund_transaction` on the same postservice URL, same hash pattern. Details (var1 = PayU id, var2 = our token, var3 = amount) must be confirmed in the PayU doc when we build.
- txnid: unique every attempt. Keep short, letters and digits only (PayU limit is about 25 characters; confirm). New txnid for every retry by the customer; link all to one order id.
- Worker has SHA-512 built in (WebCrypto). No library needed.

### 7d. Never do
- Never trust the return page alone. Never mark paid from the browser.
- Never put the Salt in the page, GitHub, chat, logs, or error messages.
- Never accept an amount from the browser. Never let two PAID updates push two Rista sales.
- Never test with live keys before Phase 7.

### 7e. Secrets list (Cloudflare only)
RISTA_KEY, RISTA_SECRET, PAYU_KEY, PAYU_SALT, DEBUG_TOKEN. (PayU MID is not secret but keep it in the Worker settings too if needed.)
Test and live PayU values are different: use separate names or swap before Phase 7 (plan: PAYU_ENV = test|live).

### 7f. What is confirmed vs not
Confirmed from PayU docs (15 Oct): request hash, reverse hash, verify_payment hash + URLs, test/live _payment URLs, refund command name, webhooks exist.
NOT confirmed: exact refund field list; whether this account allows own webhook URL and test keys; any txnid length limit; PayU settings for the DotPe-linked account.
Plan: re-open docs.payu.in at Phase 4, check the Hash Verification Tool, and test with PayU test cards/UPI.

---------------------------------------------------------------
## 8. Testing plan

### Level 1: automatic (Claude runs, `npm test`)
Today 24 tests (fake Rista data): JWT, headers, no prices out, sold-out, variants, categories, photos, cache, stale, CORS, debug lock, POST refused, hours.
To add with each phase: PayU hash (compare with PayU's published example), reverse hash, double-webhook, amount mismatch, double push, retry limit, quote total.

### Level 2: real read-only check (Phase 1, owner opens links)
6 debug links for MR. Then compare against the Rista screen: dishes, categories, Half/Full, sold-out item, photo of 3 dishes, business hours, channel name.

### Level 3: page (Phase 2, at 390 / 820 / 1280 / 1440 wide + real phone)
Outlets, open/closed, Nearest (location allowed and refused), menu, sold-out, photos, slow network, Rista down (page must show a friendly message, not break).
Also: turn MR OFF in Rista > "Closed" in about 1 minute. Mark a dish sold out > shows in about 1 minute.

### Table P: PayU test mode (Phase 4). All must pass
| # | Test | Must happen |
|---|---|---|
| P1 | Pay success | State PAID only after webhook/verify |
| P2 | Pay fail | State FAILED, no Rista order |
| P3 | Customer cancels on PayU | Back to cart, nothing sent |
| P4 | Payment pending / slow | Stays CREATED until PayU confirms |
| P5 | Customer closes tab after paying | Webhook still marks PAID |
| P6 | Webhook arrives twice | One PAID, one push |
| P7 | Fake return with wrong hash / changed amount | Rejected |

### Table F: failure drills (Phase 6)
| # | Test | Must happen |
|---|---|---|
| F1 | Rista down when paid | Stays PAID, retries, customer sees "confirming" |
| F2 | 10 failures | DEAD + alert to owner |
| F3 | Rista says 409 (repeat) | Treated as already pushed |
| F4 | Dish sold out after cart | Caught at quote and again before sale |
| F5 | Outlet closed after cart | Blocked before payment |
| F6 | Missed order | /sale/online/recent check finds it |
| F7 | Refund | PayU refund + Rista reverse both done |

### Rista test order (Phase 5, MR, owner watching)
One small order. Check on the MR Rista screen: items, qty, pickup mode, customer, paid amount, taxes = our quote. Cancel/refund it.

### Go-live checklist (all ticked before real customers)
- [ ] KYC done, PayU live key + salt in Cloudflare, live webhook URL saved in PayU
- [ ] ALLOWED_ORIGINS = real site address only
- [ ] ORDER_ENABLED_BRANCHES = MR
- [ ] P1-P7 and F1-F7 passed
- [ ] 3 carts: our total = Rista bill
- [ ] One real Rs. order placed and refunded
- [ ] Alert (email) reaches the owner
- [ ] Owner knows how to stop: delete Worker route, or turn MR off in Rista, or rotate keys
- [ ] Real-phone test done
- [ ] Privacy policy, terms, refund/cancellation pages match what we do (PayU may check)

---------------------------------------------------------------
## 9. Safety rules
- Keys and salt only in Cloudflare secrets. If ever pasted anywhere public: rotate at once.
- Worker answers to our website address only (CORS). Debug route needs DEBUG_TOKEN.
- Prices come from the server. The page output is written with textContent, never innerHTML.
- Customer data (name, phone, email): keep the minimum, only in the order store, delete when no longer needed. Never log it with secrets.
- Keep all existing site features (retain or unmask, never trim). Placeholder sections hidden unless ?edit=1.

---------------------------------------------------------------
## 10. Decisions
MADE: static site on Cloudflare Pages (code in GitHub); Cloudflare Worker; Rista API only (no DotPe link); order on our site; channel "Website" (new, 17 Oct); test outlet MR; payment = PayU (client's account, hosted checkout); 6 outlets in code (no HO, no PA).
OPEN: Cloudflare Pages address (for CORS); whether PayU gives a separate key/webhook for our site; test keys; who gets the failure alert (email? WhatsApp?); order store choice (KV or D1, default D1); customer fields on checkout (name, phone, email: PayU needs firstname + email + phone); pickup time slot ("ready in X minutes" or choose time); cancellation rule by customer.

---------------------------------------------------------------
## 11. Files
| File | Job |
|---|---|
| FULL-PLAN.md | This file. Master plan. |
| RESUME-PROMPT.md | Paste at the start of a new chat. |
| PLAN.md | Detail history: v1.1, v1.2 changes, old-file findings. |
| SETUP.md | Owner steps to deploy + 6 debug links. |
| page-example.js | How the page will call the API (reference). |
| src/*.js, test/*.mjs | Worker code and tests. |
Older zips (rr-durbar-v50, rr-durbar-final (2), -v16-support): WordPress era, mostly NOT reused. Their old rules we kept: send each sale once, retry max 10, never trust return page.
Other open items (not Pickup): performance (mobile 30, TBT 6 s, ~8.3 MB), grievance officer name, analytics/consent banner, contact page placeholder text, Poranki address mismatch, real-device testing, awards gallery pause button, update AUDIT.md + RELEASE-CHECKLIST.md to v50.

---------------------------------------------------------------
## 12. Session start protocol
1. Read FULL-PLAN.md then RESUME-PROMPT.md.
2. Say in 3 short lines what you understood. Ask ONE question.
3. Short, simple English. One question at a time. Be honest about guesses.
4. Do not build until the owner says "build". Then do only the next phase.
