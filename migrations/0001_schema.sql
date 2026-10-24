-- RR Durbar ordering API: D1 schema, part 1 of 2 (tables and indexes). Task 4.2.
-- Source: RR_Durbar_API_Contract.md v1 sections 4 and 5. All money is INTEGER PAISE. Times are ISO 8601 UTC text.
-- D1 is SQLite: no STRICT tables, no PRAGMA statements here (keep this file portable for `wrangler d1 migrations apply`).
-- Never store: raw OTP codes, PayU salt/keys, Reelo keys, full IPs, Rista tokens, provider raw responses.

CREATE TABLE customers (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  phone       TEXT NOT NULL UNIQUE CHECK (length(phone) = 10 AND phone NOT GLOB '*[^0-9]*' AND substr(phone,1,1) IN ('6','7','8','9')),
  name        TEXT,
  email       TEXT,
  created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

-- Append-only consent history (terms and marketing are separate rows; never update, insert a new row to change).
CREATE TABLE consents (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  customer_id     INTEGER NOT NULL REFERENCES customers(id),
  kind            TEXT NOT NULL CHECK (kind IN ('terms','marketing')),
  granted         INTEGER NOT NULL CHECK (granted IN (0,1)),
  wording_version TEXT NOT NULL CHECK (length(wording_version) > 0),
  order_id        TEXT,
  ip_hash         TEXT,
  at              TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX idx_consents_customer ON consents (customer_id, kind, at);

CREATE TABLE orders (
  id                 TEXT PRIMARY KEY CHECK (id GLOB 'RR-[0-9]*'),          -- order id doubles as PayU txnid (<= 25 chars)
  branch             TEXT NOT NULL CHECK (length(branch) BETWEEN 2 AND 40),  -- lowercase slug; allowed list lives in config, not here
  slot_at            TEXT NOT NULL,
  method             TEXT NOT NULL CHECK (method IN ('payu','cod')),
  state              TEXT NOT NULL CHECK (state IN ('CREATED','PAYMENT_PENDING','PAID','PAYMENT_FAILED','EXPIRED','PUSHED_TO_RISTA','PUSH_FAILED','CONFIRMED','REFUND_NEEDED','REFUNDED','CANCELLED')),
  version            INTEGER NOT NULL DEFAULT 0 CHECK (version >= 0),        -- app bumps it on every update (compare-and-set)
  subtotal_paise     INTEGER NOT NULL CHECK (subtotal_paise >= 0),
  tax_paise          INTEGER NOT NULL CHECK (tax_paise >= 0),
  charges_paise      INTEGER NOT NULL DEFAULT 0 CHECK (charges_paise >= 0),  -- packaging or other Rista charges (task 4.5 to confirm)
  total_paise        INTEGER NOT NULL CHECK (total_paise > 0),
  customer_id        INTEGER NOT NULL REFERENCES customers(id),
  status_token_hash  TEXT NOT NULL,                                           -- hash only; the token itself is shown once
  earn_points        INTEGER NOT NULL DEFAULT 0 CHECK (earn_points >= 0),
  last_actor         TEXT,                                                    -- set by the app in the same UPDATE as state; copied to events by trigger
  last_note          TEXT,
  created_at         TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at         TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  confirmed_at       TEXT,
  CHECK (total_paise = subtotal_paise + tax_paise + charges_paise),
  -- Rs 1000 pay-at-pickup rule (D9): defence in depth, the API checks it first. Inclusive. Changing the limit needs a new migration.
  CHECK (method <> 'cod' OR total_paise <= 100000),
  -- state must fit the payment method
  CHECK (method <> 'payu' OR state NOT IN ('CREATED')),
  CHECK (method <> 'cod'  OR state NOT IN ('PAYMENT_PENDING','PAID','PAYMENT_FAILED','EXPIRED','REFUND_NEEDED','REFUNDED'))
);
CREATE INDEX idx_orders_customer_state ON orders (customer_id, state);
CREATE INDEX idx_orders_state_updated  ON orders (state, updated_at);        -- cron: expire, retry pushes
CREATE INDEX idx_orders_branch_slot    ON orders (branch, slot_at);

CREATE TABLE order_items (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  order_id       TEXT NOT NULL REFERENCES orders(id),
  rista_item_id  TEXT NOT NULL,
  name           TEXT NOT NULL,                                               -- Rista name (what is ordered)
  qty            INTEGER NOT NULL CHECK (qty BETWEEN 1 AND 20),
  unit_paise     INTEGER NOT NULL CHECK (unit_paise >= 0),
  line_paise     INTEGER NOT NULL CHECK (line_paise = unit_paise * qty)
);
CREATE INDEX idx_order_items_order ON order_items (order_id);

CREATE TABLE payments (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  order_id     TEXT NOT NULL REFERENCES orders(id),
  txnid        TEXT NOT NULL UNIQUE,
  payu_ref     TEXT,
  status       TEXT NOT NULL CHECK (status IN ('INITIATED','SUCCESS','FAILURE','MISMATCH','REFUNDED')),
  amount_paise INTEGER NOT NULL CHECK (amount_paise > 0),                     -- what PayU confirmed, compared with orders.total_paise in code
  verified_at  TEXT,
  created_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX idx_payments_order ON payments (order_id);
CREATE UNIQUE INDEX uq_payments_one_success ON payments (order_id) WHERE status = 'SUCCESS';   -- an order is paid once

CREATE TABLE rista_pushes (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  order_id   TEXT NOT NULL REFERENCES orders(id),
  attempt    INTEGER NOT NULL CHECK (attempt >= 1),
  status     TEXT NOT NULL CHECK (status IN ('OK','FAILED')),
  http_code  INTEGER,
  at         TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  UNIQUE (order_id, attempt)
);

CREATE TABLE events (                                                          -- audit log: written by trigger on every state change
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  order_id    TEXT NOT NULL REFERENCES orders(id),
  from_state  TEXT,
  to_state    TEXT NOT NULL,
  actor       TEXT NOT NULL,                                                  -- 'api','payu_callback','payu_webhook','cron','owner'
  note        TEXT,
  at          TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX idx_events_order ON events (order_id, id);

-- Idempotency for POST /checkout/start. Same key + same request_hash returns response_json; same key + other hash = 409.
CREATE TABLE idempotency_keys (
  key           TEXT PRIMARY KEY CHECK (length(key) BETWEEN 16 AND 64),
  phone         TEXT NOT NULL,
  request_hash  TEXT NOT NULL,
  order_id      TEXT REFERENCES orders(id),
  response_json TEXT,
  created_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  expires_at    TEXT NOT NULL
);
CREATE INDEX idx_idem_expires ON idempotency_keys (expires_at);

-- OTP. The code is stored only as a keyed hash. Attempt cap is enforced by the database (KV is not atomic).
-- Verify with:  UPDATE otp_challenges SET attempts = attempts + 1 WHERE id = ? AND attempts < 5 AND consumed_at IS NULL AND expires_at > ?   (then check changes() = 1)
CREATE TABLE otp_challenges (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  phone        TEXT NOT NULL,
  code_hash    TEXT NOT NULL,
  attempts     INTEGER NOT NULL DEFAULT 0 CHECK (attempts BETWEEN 0 AND 5),
  created_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  expires_at   TEXT NOT NULL,
  consumed_at  TEXT
);
CREATE INDEX idx_otp_phone ON otp_challenges (phone, created_at);

-- One row per issued token. Claim with: UPDATE otp_nonces SET uses = uses + 1 WHERE nonce = ? AND uses < max_uses AND expires_at > ?  (changes() = 1)
CREATE TABLE otp_nonces (
  nonce        TEXT PRIMARY KEY,
  phone        TEXT NOT NULL,
  challenge_id INTEGER REFERENCES otp_challenges(id),
  uses         INTEGER NOT NULL DEFAULT 0,
  max_uses     INTEGER NOT NULL DEFAULT 1 CHECK (max_uses >= 1),
  created_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  expires_at   TEXT NOT NULL,
  CHECK (uses >= 0 AND uses <= max_uses)
);
CREATE INDEX idx_nonces_expires ON otp_nonces (expires_at);

-- Rate limiting that must be exact (OTP sends per phone and per IP, checkout/start per phone). bucket e.g. 'otp_phone','otp_ip','start_phone'. key = phone or ip_hash.
CREATE TABLE rate_events (
  id      INTEGER PRIMARY KEY AUTOINCREMENT,
  bucket  TEXT NOT NULL,
  key     TEXT NOT NULL,
  at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX idx_rate_lookup ON rate_events (bucket, key, at);

-- Loyalty (Reelo), earn-only v1. UNIQUE (order_id, kind) = this order can never be credited twice by us.
-- Redeem and revert kinds are added by a later migration if the owner decides on online redemption (Reelo spec R1).
CREATE TABLE loyalty_events (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  order_id        TEXT NOT NULL REFERENCES orders(id),
  customer_id     INTEGER NOT NULL REFERENCES customers(id),
  kind            TEXT NOT NULL CHECK (kind IN ('earn')),
  points          INTEGER NOT NULL CHECK (points >= 0),
  status          TEXT NOT NULL DEFAULT 'PENDING' CHECK (status IN ('PENDING','SENT','FAILED','SKIPPED')),
  attempts        INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  next_attempt_at TEXT,
  last_error      TEXT,                                                       -- error CODE only (down, rejected...), never provider text
  provider_ref    TEXT,
  created_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  sent_at         TEXT,
  UNIQUE (order_id, kind)
);
CREATE INDEX idx_loyalty_pending ON loyalty_events (status, next_attempt_at);
