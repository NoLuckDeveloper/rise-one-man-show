'use strict';
const { Pool } = require('pg');

const connectionString = process.env.DATABASE_URL;
if (!connectionString) {
  console.error('[db] DATABASE_URL is not set — the server cannot run without Postgres.');
}

const pool = new Pool({
  connectionString,
  // Render's internal connection strings do not need SSL; external ones do.
  ssl: connectionString && /render\.com|amazonaws|heroku/.test(connectionString)
    ? { rejectUnauthorized: false }
    : undefined,
});

function q(text, params) {
  return pool.query(text, params);
}
async function one(text, params) {
  const r = await pool.query(text, params);
  return r.rows[0] || null;
}
async function many(text, params) {
  const r = await pool.query(text, params);
  return r.rows;
}

// ---------------------------------------------------------------------------
// Schema. Idempotent: CREATE TABLE IF NOT EXISTS / CREATE INDEX IF NOT EXISTS,
// safe to run on every boot. Every tenant-owned table carries company_id and
// every query in the app scopes by it.
// ---------------------------------------------------------------------------
const MIGRATIONS = `
CREATE TABLE IF NOT EXISTS companies (
  id          SERIAL PRIMARY KEY,
  name        TEXT NOT NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS users (
  id            SERIAL PRIMARY KEY,
  company_id    INTEGER REFERENCES companies(id) ON DELETE CASCADE, -- NULL = platform admin
  name          TEXT NOT NULL,
  email         TEXT NOT NULL UNIQUE,             -- stored lowercased
  password_hash TEXT NOT NULL,
  role          TEXT NOT NULL DEFAULT 'tech',     -- owner | admin | tech | platform
  active        BOOLEAN NOT NULL DEFAULT TRUE,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_users_company ON users(company_id);

CREATE TABLE IF NOT EXISTS sessions (
  token      TEXT PRIMARY KEY,
  user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at TIMESTAMPTZ NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id);

CREATE TABLE IF NOT EXISTS subscriptions (
  id                    SERIAL PRIMARY KEY,
  company_id            INTEGER NOT NULL UNIQUE REFERENCES companies(id) ON DELETE CASCADE,
  status                TEXT NOT NULL DEFAULT 'trialing', -- trialing|active|past_due|canceled|trial_ended
  trial_start           TIMESTAMPTZ NOT NULL DEFAULT now(),
  trial_end             TIMESTAMPTZ NOT NULL,
  current_period_end    TIMESTAMPTZ,
  stripe_customer_id    TEXT,
  stripe_subscription_id TEXT,
  payment_brand         TEXT,
  payment_last4         TEXT,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS billing_events (
  id         SERIAL PRIMARY KEY,
  company_id INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  type       TEXT NOT NULL,
  detail     TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_billing_events_company ON billing_events(company_id);

CREATE TABLE IF NOT EXISTS company_settings (
  company_id        INTEGER PRIMARY KEY REFERENCES companies(id) ON DELETE CASCADE,
  hourly_rate_cents INTEGER NOT NULL DEFAULT 0,
  tax_percent       NUMERIC NOT NULL DEFAULT 0,
  parts_multiplier  NUMERIC NOT NULL DEFAULT 1,
  reminder_in       TEXT NOT NULL DEFAULT '08:30',
  reminder_out      TEXT NOT NULL DEFAULT '16:30',
  pay_anchor        DATE NOT NULL DEFAULT DATE '2026-10-11',
  pay_cycle_days    INTEGER NOT NULL DEFAULT 14,
  quarter_start     DATE NOT NULL DEFAULT DATE '2026-10-01',
  quarter_end       DATE NOT NULL DEFAULT DATE '2026-12-31'
);

CREATE TABLE IF NOT EXISTS calls (
  id             SERIAL PRIMARY KEY,
  company_id     INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  customer_name  TEXT NOT NULL,
  address        TEXT,
  phone          TEXT,
  poc_name       TEXT,
  poc_phone      TEXT,
  description    TEXT,
  status         TEXT NOT NULL DEFAULT 'bucket', -- bucket|scheduled|traveling|on_job|completed
  scheduled_date DATE,
  scheduled_time TEXT,
  root_call_id   INTEGER,                        -- chain root (follow-ups); NULL = itself
  parent_call_id INTEGER REFERENCES calls(id) ON DELETE SET NULL,
  created_by     INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  completed_at   TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idx_calls_company ON calls(company_id);
CREATE INDEX IF NOT EXISTS idx_calls_root ON calls(root_call_id);

CREATE TABLE IF NOT EXISTS job_reports (
  id                   SERIAL PRIMARY KEY,
  call_id              INTEGER NOT NULL UNIQUE REFERENCES calls(id) ON DELETE CASCADE,
  company_id           INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  asset_name           TEXT,
  asset_make           TEXT,
  asset_model          TEXT,
  asset_serial         TEXT,
  location_on_site     TEXT,
  work_performed       TEXT,
  parts                JSONB NOT NULL DEFAULT '[]',  -- [{qty, description, costCents}]
  notes                TEXT,
  photos               JSONB NOT NULL DEFAULT '[]',  -- [dataURL, ...] (v1: inline, downscaled client-side)
  follow_up            BOOLEAN NOT NULL DEFAULT FALSE,
  follow_up_date       DATE,
  follow_up_description TEXT,
  complete             BOOLEAN NOT NULL DEFAULT FALSE,
  updated_at           TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_reports_company ON job_reports(company_id);

CREATE TABLE IF NOT EXISTS trips (
  id         SERIAL PRIMARY KEY,
  company_id INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  call_id    INTEGER REFERENCES calls(id) ON DELETE SET NULL,
  user_id    INTEGER REFERENCES users(id) ON DELETE SET NULL,
  kind       TEXT NOT NULL DEFAULT 'travel', -- travel | manual
  miles      NUMERIC NOT NULL DEFAULT 0,
  note       TEXT,
  started_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  ended_at   TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idx_trips_company ON trips(company_id);

CREATE TABLE IF NOT EXISTS punches (
  id         SERIAL PRIMARY KEY,
  company_id INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  call_id    INTEGER REFERENCES calls(id) ON DELETE SET NULL,
  user_id    INTEGER REFERENCES users(id) ON DELETE SET NULL,
  job_label  TEXT,
  clock_in   TIMESTAMPTZ NOT NULL DEFAULT now(),
  clock_out  TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idx_punches_company ON punches(company_id);

CREATE TABLE IF NOT EXISTS gas_purchases (
  id            SERIAL PRIMARY KEY,
  company_id    INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  user_id       INTEGER REFERENCES users(id) ON DELETE SET NULL,
  date          DATE NOT NULL DEFAULT CURRENT_DATE,
  amount_cents  INTEGER NOT NULL DEFAULT 0,
  gallons       NUMERIC,
  note          TEXT,
  receipt_photo TEXT,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_gas_company ON gas_purchases(company_id);

CREATE TABLE IF NOT EXISTS maintenance_receipts (
  id            SERIAL PRIMARY KEY,
  company_id    INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  user_id       INTEGER REFERENCES users(id) ON DELETE SET NULL,
  date          DATE NOT NULL DEFAULT CURRENT_DATE,
  amount_cents  INTEGER NOT NULL DEFAULT 0,
  work_done     TEXT,
  shop          TEXT,
  note          TEXT,
  receipt_photo TEXT,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_maint_company ON maintenance_receipts(company_id);
`;

async function migrate() {
  await pool.query(MIGRATIONS);
}

async function billingEvent(companyId, type, detail) {
  await q('INSERT INTO billing_events (company_id, type, detail) VALUES ($1,$2,$3)', [companyId, type, detail || null]);
}

module.exports = { pool, q, one, many, migrate, billingEvent };
