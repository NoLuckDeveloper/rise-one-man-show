'use strict';
// End-to-end tier flows over HTTP against a real Postgres. SKIPPED unless
// RISE_TEST_DATABASE_URL is set (e.g. a scratch database): the suite must
// never touch a production database.
//   RISE_TEST_DATABASE_URL=postgres://user:pass@localhost:5432/rise_test node tests/http-tiers.test.js
const assert = require('node:assert');

if (!process.env.RISE_TEST_DATABASE_URL) {
  console.log('http-tiers.test.js SKIP (RISE_TEST_DATABASE_URL not set)');
  process.exit(0);
}

process.env.DATABASE_URL = process.env.RISE_TEST_DATABASE_URL;
process.env.SESSION_SECRET = 'http-tier-test-secret';
delete process.env.STRIPE_SECRET_KEY;
delete process.env.STRIPE_PUBLISHABLE_KEY;
delete process.env.STRIPE_PRICE_ID;
delete process.env.STRIPE_WEBHOOK_SECRET;

const db = require('../server/db');
const auth = require('../server/auth');
const { app } = require('../server/index');

let base;
let server;

function cookieFrom(res) {
  const set = res.headers.get('set-cookie') || '';
  const m = set.match(/sid=[^;]+/);
  return m ? m[0] : '';
}

async function post(path, fields, cookie) {
  const res = await fetch(base + path, {
    method: 'POST',
    redirect: 'manual',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', ...(cookie ? { Cookie: cookie } : {}) },
    body: new URLSearchParams(fields),
  });
  return res;
}

async function get(path, cookie) {
  return fetch(base + path, { redirect: 'manual', headers: cookie ? { Cookie: cookie } : {} });
}

(async () => {
  await db.migrate();
  await db.q('TRUNCATE companies, users, sessions, subscriptions, billing_events, company_settings, calls, job_reports, trips, punches, gas_purchases, maintenance_receipts, customers, trip_positions RESTART IDENTITY CASCADE');

  server = app.listen(0);
  await new Promise((r) => server.on('listening', r));
  base = `http://127.0.0.1:${server.address().port}`;

  // 1. Signup on team3 persists the tier.
  const signup = await post('/signup', { company_name: 'Tier Co', owner_name: 'Owner', email: 'owner@tier.test', password: 'password123', plan_tier: 'team3' });
  assert.strictEqual(signup.status, 302);
  const cookie = cookieFrom(signup);
  assert.ok(cookie, 'signup did not set a session cookie');
  let co = await db.one('SELECT * FROM companies WHERE name = $1', ['Tier Co']);
  assert.strictEqual(co.plan_tier, 'team3');

  // 2. Users page shows seat usage; cap enforced at 3 total users.
  let usersPage = await (await get('/app/users', cookie)).text();
  assert.ok(usersPage.includes('1 of 3 used'), 'users page missing seat usage');
  for (const n of ['Tech One', 'Tech Two']) {
    const r = await post('/app/users', { name: n, email: `${n.replace(' ', '').toLowerCase()}@tier.test`, password: 'password123', role: 'tech' }, cookie);
    assert.strictEqual(r.status, 302);
    assert.ok(!String(r.headers.get('location')).includes('err='), 'adding a user within cap failed');
  }
  const over = await post('/app/users', { name: 'Tech Three', email: 'techthree@tier.test', password: 'password123', role: 'tech' }, cookie);
  const overLoc = String(over.headers.get('location') || '');
  assert.ok(overLoc.includes('err='), 'over-cap user creation was not refused');
  assert.ok(decodeURIComponent(overLoc).includes('Seat limit reached'), 'over-cap error lacks the seat message');

  // 3. Plan upgrade team3 -> team6 works; then a 4th user fits.
  const up = await post('/app/billing/plan-change', { plan_tier: 'team6' }, cookie);
  assert.ok(String(up.headers.get('location')).includes('msg='), 'upgrade did not succeed');
  co = await db.one('SELECT * FROM companies WHERE id = $1', [co.id]);
  assert.strictEqual(co.plan_tier, 'team6');
  const fourth = await post('/app/users', { name: 'Tech Three', email: 'techthree@tier.test', password: 'password123', role: 'tech' }, cookie);
  assert.ok(!String(fourth.headers.get('location')).includes('err='), '4th user after upgrade failed');

  // 4. Downgrade below headcount (4 users) is refused for solo and team3.
  for (const tier of ['solo', 'team3']) {
    const down = await post('/app/billing/plan-change', { plan_tier: tier }, cookie);
    const loc = decodeURIComponent(String(down.headers.get('location') || ''));
    assert.ok(loc.includes('err=') && loc.includes('Remove users first'), `downgrade to ${tier} was not refused`);
  }
  co = await db.one('SELECT * FROM companies WHERE id = $1', [co.id]);
  assert.strictEqual(co.plan_tier, 'team6');

  // 5. Platform MRR reflects the team6 rate ($47.99).
  const hash = await auth.hashPassword('platformpass123');
  await db.q("INSERT INTO users (company_id, name, email, password_hash, role) VALUES (NULL, 'Platform', 'platform@tier.test', $1, 'platform')", [hash]);
  const login = await post('/login', { email: 'platform@tier.test', password: 'platformpass123' });
  const pcookie = cookieFrom(login);
  const platform = await (await get('/platform', pcookie)).text();
  assert.ok(platform.includes('$47.99'), 'platform MRR missing team6 rate');
  assert.ok(platform.includes('Team · up to 6'), 'platform missing tier breakdown');

  // 6. Public copy shows all four tiers.
  const landing = await (await get('/', null)).text();
  for (const price of ['$10.99', '$28.49', '$47.99', '$64.99']) assert.ok(landing.includes(price), `landing missing ${price}`);
  const signupPage = await (await get('/signup', null)).text();
  for (const id of ['solo', 'team3', 'team6', 'team10']) assert.ok(signupPage.includes(`value="${id}"`), `signup missing ${id}`);

  console.log('http-tiers.test.js PASS');
  server.close();
  await db.pool.end();
})().catch(async (e) => {
  console.error('http-tiers.test.js FAIL:', e);
  try { server && server.close(); } catch (_) {}
  try { await db.pool.end(); } catch (_) {}
  process.exit(1);
});
