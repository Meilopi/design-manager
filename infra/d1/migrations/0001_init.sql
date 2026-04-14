-- Design Manager — initial D1 schema
-- See docs/ARCHITECTURE.md §6 and §7 for context.

CREATE TABLE IF NOT EXISTS products (
  id                   TEXT PRIMARY KEY,               -- slug, e.g. 'billing-app'
  name                 TEXT NOT NULL,
  auth_strategy        TEXT NOT NULL CHECK (auth_strategy IN ('impersonation', 'session')),
  magic_link_endpoint  TEXT,
  signing_public_key   TEXT,                           -- PEM/JWK used to verify this product's impersonation JWTs
  concurrency_cap      INTEGER NOT NULL DEFAULT 2,
  default_settle_json  TEXT,                           -- JSON SettleConfig
  created_at           INTEGER NOT NULL                -- unix ms
);

CREATE TABLE IF NOT EXISTS acl (
  email      TEXT PRIMARY KEY,
  role       TEXT NOT NULL CHECK (role IN ('viewer', 'operator', 'admin')),
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS jobs (
  id                   TEXT PRIMARY KEY,
  product_id           TEXT NOT NULL REFERENCES products(id),
  user_id              TEXT NOT NULL,
  url                  TEXT NOT NULL,
  viewport_width       INTEGER,
  viewport_height      INTEGER,
  status               TEXT NOT NULL CHECK (status IN ('queued', 'running', 'completed', 'failed')),
  workflow_instance_id TEXT,
  r2_prefix            TEXT,
  error                TEXT,
  requested_by_json    TEXT NOT NULL,                  -- serialized RequestOrigin
  created_at           INTEGER NOT NULL,
  updated_at           INTEGER NOT NULL,
  completed_at         INTEGER
);

CREATE INDEX IF NOT EXISTS idx_jobs_created_at ON jobs (created_at DESC);
CREATE INDEX IF NOT EXISTS idx_jobs_product_status ON jobs (product_id, status);

-- Strongly-consistent, one-shot auth-material scratchpad for flows where the
-- ciphertext cannot ride inside the queue message (oversized tokens, UI paste).
-- KV is deliberately NOT used for this purpose because of its ~60s global
-- propagation delay, which would race the Workflow's first step.
CREATE TABLE IF NOT EXISTS auth_grants (
  grant_id     TEXT PRIMARY KEY,
  ciphertext   TEXT NOT NULL,                          -- base64url, AES-GCM
  iv           TEXT NOT NULL,                          -- base64url
  expires_at   INTEGER NOT NULL,                       -- unix ms
  consumed_at  INTEGER,                                -- unix ms, null until first read
  created_at   INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_auth_grants_expires ON auth_grants (expires_at);

CREATE TABLE IF NOT EXISTS audit_log (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  timestamp      INTEGER NOT NULL,                     -- unix ms
  actor_email    TEXT,
  actor_product  TEXT,
  action         TEXT NOT NULL,                        -- e.g. 'capture.create', 'auth.decrypt'
  target_type    TEXT,
  target_id      TEXT,
  metadata_json  TEXT
);

CREATE INDEX IF NOT EXISTS idx_audit_log_timestamp ON audit_log (timestamp DESC);
CREATE INDEX IF NOT EXISTS idx_audit_log_target ON audit_log (target_type, target_id);
