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

-- Invoice payments (Stripe Connect + manual) --------------------------------
-- Invoices are derived from a call chain (see invoiceFor in index.js), so the
-- payment state lives on the chain's ROOT call: payment_status / method /
-- reference / paid_at, plus the unguessable pay_token used by the public
-- /pay/:token page. customer_email is the invoice recipient, captured at
-- intake and copied onto follow-up calls; the root call's value is the one
-- the invoice uses.
ALTER TABLE calls ADD COLUMN IF NOT EXISTS customer_email TEXT;
ALTER TABLE calls ADD COLUMN IF NOT EXISTS pay_token TEXT;
ALTER TABLE calls ADD COLUMN IF NOT EXISTS payment_status TEXT NOT NULL DEFAULT 'unpaid';
ALTER TABLE calls ADD COLUMN IF NOT EXISTS payment_method TEXT;
ALTER TABLE calls ADD COLUMN IF NOT EXISTS payment_reference TEXT;
ALTER TABLE calls ADD COLUMN IF NOT EXISTS paid_at TIMESTAMPTZ;
ALTER TABLE calls ADD COLUMN IF NOT EXISTS invoice_emailed_at TIMESTAMPTZ;
ALTER TABLE calls ADD COLUMN IF NOT EXISTS invoice_email_recipient TEXT;
CREATE UNIQUE INDEX IF NOT EXISTS idx_calls_pay_token ON calls (pay_token) WHERE pay_token IS NOT NULL;

-- Customer-level contact records ------------------------------------------
-- Calls remain the operational record and customers are still presented by
-- grouping calls, but this table is the durable customer-level email source.
-- It is keyed exactly like the derived customer view: (company_id,
-- customer_name). Backfill uses each customer's most recent non-empty email
-- already captured on a call, without overwriting a customer record that is
-- already present on a later boot.
CREATE TABLE IF NOT EXISTS customers (
  id            SERIAL PRIMARY KEY,
  company_id    INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  customer_name TEXT NOT NULL,
  email         TEXT,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (company_id, customer_name)
);
CREATE INDEX IF NOT EXISTS idx_customers_company ON customers(company_id);
INSERT INTO customers (company_id, customer_name, email)
SELECT company_id, customer_name, email
  FROM (
    SELECT DISTINCT ON (company_id, customer_name)
           company_id,
           customer_name,
           LOWER(TRIM(customer_email)) AS email
      FROM calls
     WHERE customer_email IS NOT NULL AND TRIM(customer_email) <> ''
     ORDER BY company_id, customer_name, id DESC
  ) AS latest_customer_emails
ON CONFLICT (company_id, customer_name) DO NOTHING;

-- Per-company Stripe Connect account (invoice card payments). In TEST MODE
-- (no platform Stripe keys) a simulated acct_test_* id is stored instead.
ALTER TABLE company_settings ADD COLUMN IF NOT EXISTS stripe_account_id TEXT;
ALTER TABLE company_settings ADD COLUMN IF NOT EXISTS stripe_charges_enabled BOOLEAN NOT NULL DEFAULT FALSE;

-- Native-app GPS positions for open travel trips (background tracking).
-- One row per fix; trip miles accumulate from consecutive points server-side.
CREATE TABLE IF NOT EXISTS trip_positions (
  id          SERIAL PRIMARY KEY,
  trip_id     INTEGER NOT NULL REFERENCES trips(id) ON DELETE CASCADE,
  company_id  INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  lat         DOUBLE PRECISION NOT NULL,
  lng         DOUBLE PRECISION NOT NULL,
  accuracy_m  DOUBLE PRECISION,
  recorded_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_trip_positions_trip ON trip_positions(trip_id);

-- Dispatch: call assignment. NULL = unassigned, visible to owner/admin
-- only; techs see only calls assigned to them. Existing calls backfill to
-- NULL, which is consistent with the tech-visibility rule.
ALTER TABLE calls ADD COLUMN IF NOT EXISTS assigned_user_id INTEGER REFERENCES users(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS idx_calls_assigned ON calls(assigned_user_id);

-- Subscription tiers (solo | team3 | team6 | team10). Seat caps count
-- total active users per company. ADD COLUMN ... DEFAULT fills existing
-- rows with 'solo', which is correct: every pre-tier subscription was on
-- the solo $10.99 price, so nothing changes for existing companies. The
-- UPDATE is belt-and-braces for any row holding an unknown value.
ALTER TABLE companies ADD COLUMN IF NOT EXISTS plan_tier TEXT NOT NULL DEFAULT 'solo';
UPDATE companies SET plan_tier = 'solo' WHERE plan_tier NOT IN ('solo', 'team3', 'team6', 'team10');
`;

async function migrate() {
  await pool.query(MIGRATIONS);
}

async function billingEvent(companyId, type, detail) {
  await q('INSERT INTO billing_events (company_id, type, detail) VALUES ($1,$2,$3)', [companyId, type, detail || null]);
}

module.exports = { pool, q, one, many, migrate, billingEvent };
