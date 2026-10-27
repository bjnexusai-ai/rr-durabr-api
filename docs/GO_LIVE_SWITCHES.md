# RR Durbar ordering: switch-on order (deploy session)

Everything ships closed (`wrangler.toml` [vars]). Check after each step: `GET /api/health`, and `GET /api/admin/selfcheck` with header `x-admin-key`.
Self-check lists the NAMES of anything missing. It never shows values.

1. **Base secrets** (hidden prompt): `TOKEN_SIGNING_KEY`, `OTP_HASH_SECRET` (32+ random characters each), `ADMIN_KEY` (32+).
2. **Turnstile**: `TURNSTILE_SECRET` (the site key goes in the checkout page). Without it no SMS is ever sent.
3. **SMS**: `MSG91_AUTHKEY`, `MSG91_TEMPLATE_ID` (DLT-approved template, `OWNER_MESSAGES.md` section 1).
4. **PayU test**: `PAYU_KEY`, `PAYU_SALT` with `PAYU_MODE = "test"`. Run a test payment, a failure and a cancel.
5. **Staff test at MR**: `ONLINE_ORDER_LIVE = "true"`, `RISTA_PUSH_LIVE = "true"`, `RISTA_PUSH_TEST = "true"`, only MR in `ONLINE_OUTLETS_LIVE`. Place 2 orders; check the counter screen and the KOT print.
6. **Real orders at MR**: `RISTA_PUSH_TEST = "false"`, `PAYU_MODE = "live"` (live key and salt). 3 to 5 real orders.
7. **Pay at pickup**: `COD_LIVE = "true"` (orders up to Rs 1000).
8. **More outlets**: add them to `ONLINE_OUTLETS_LIVE` one at a time (`singhnagar,bhavanipuram,poranki,autonagar`). Patamatalanka stays call-only.
9. **Rewards**: `LOYALTY_PROVIDER = "reelo"` plus the Reelo secrets, after the client confirms R1 to R5.
10. **Domain move**: `SITE_ORIGIN = "https://rrdurbar.com"`, and add `https://rrdurbar.com` to `ALLOWED_ORIGINS`.

Emergency stop: `ONLINE_ORDER_LIVE = "false"` and deploy. Orders already paid keep working (status page, PayU callback, Rista retries).
