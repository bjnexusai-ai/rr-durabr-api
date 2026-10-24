-- DEV AND STAGING ONLY. Never run against production data. Run in this order.
DROP VIEW IF EXISTS v_open_orders;
DROP TRIGGER IF EXISTS trg_orders_state_guard; DROP TRIGGER IF EXISTS trg_orders_state_event; DROP TRIGGER IF EXISTS trg_orders_created_event;
DROP TRIGGER IF EXISTS trg_consents_no_update; DROP TRIGGER IF EXISTS trg_consents_no_delete; DROP TRIGGER IF EXISTS trg_events_no_update; DROP TRIGGER IF EXISTS trg_events_no_delete;
DROP TABLE IF EXISTS loyalty_events; DROP TABLE IF EXISTS rate_events; DROP TABLE IF EXISTS otp_nonces; DROP TABLE IF EXISTS otp_challenges;
DROP TABLE IF EXISTS idempotency_keys; DROP TABLE IF EXISTS events; DROP TABLE IF EXISTS rista_pushes; DROP TABLE IF EXISTS payments;
DROP TABLE IF EXISTS order_items; DROP TABLE IF EXISTS orders; DROP TABLE IF EXISTS consents; DROP TABLE IF EXISTS customers;
