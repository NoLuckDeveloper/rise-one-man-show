'use strict';
// Billing tier logic against a fake in-memory DB, injected through the
// require cache before billing.js loads (billing destructures ./db at
// require time, so the fake must be in place first). No real Postgres,
// no Stripe calls — TEST MODE is on (no Stripe env vars are set).
const assert = require('node:assert');

delete process.env.STRIPE_SECRET_KEY;
delete process.env.STRIPE_PUBLISHABLE_KEY;
delete process.env.STRIPE_PRICE_ID;
delete process.env.STRIPE_WEBHOOK_SECRET;
process.env.STRIPE_PRICE_TIER_3 = 'price_test_team3';
process.env.STRIPE_PRICE_TIER_6 = 'price_test_team6';
process.env.STRIPE_PRICE_TIER_10 = 'price_test_team10';

const dbPath = require.resolve('../server/db');
const state = { companies: [], subs: [], users: [], events: [] };

function reset(companies, subs, users) {
  state.companies = companies;
  state.subs = subs;
  state.users = users;
  state.events = [];
}

const fakeDb = {
  pool: null,
  migrate: async () => {},
  billingEvent: async (companyId, type, detail) => {
    state.events.push({ company_id: companyId, type, detail });
  },
  one: async (text, params) => {
    if (/FROM subscriptions WHERE company_id/.test(text)) {
      return state.subs.find((s) => s.company_id === params[0]) || null;
    }
    if (/FROM subscriptions WHERE stripe_customer_id/.test(text)) {
      return state.subs.find((s) => s.stripe_customer_id === params[0]) || null;
    }
    if (/COUNT\(\*\)::int AS n FROM users/.test(text)) {
      return { n: state.users.filter((u) => u.company_id === params[0] && u.active).length };
    }
    throw new Error(`fakeDb.one: unexpected query: ${text}`);
  },
  many: async () => { throw new Error('fakeDb.many: not used by tier flows'); },
  q: async (text, params) => {
    if (/^UPDATE companies SET plan_tier/.test(text)) {
      const c = state.companies.find((x) => x.id === params[0]);
      if (c) c.plan_tier = params[1];
      return { rowCount: c ? 1 : 0 };
    }
    if (/^UPDATE subscriptions SET/.test(text)) {
      const sub = state.subs.find((s) => s.company_id === params[0]);
      if (!sub) return { rowCount: 0 };
      for (const m of text.matchAll(/(\w+) = \$(\d+)/g)) {
        sub[m[1]] = params[Number(m[2]) - 1];
      }
      return { rowCount: 1 };
    }
    throw new Error(`fakeDb.q: unexpected query: ${text}`);
  },
};
require.cache[dbPath] = { id: dbPath, filename: dbPath, loaded: true, exports: fakeDb };

const billing = require('../server/billing');
assert.strictEqual(billing.TEST_MODE, true);

function company(id, planTier) {
  return { id, name: `Co ${id}`, plan_tier: planTier };
}
function sub(companyId, status, extra = {}) {
  return { company_id: companyId, status, trial_end: new Date(Date.now() + 86400000), current_period_end: null, stripe_customer_id: null, stripe_subscription_id: null, payment_last4: null, ...extra };
}
function user(id, companyId, active = true) {
  return { id, company_id: companyId, active };
}

(async () => {
  // 1. TEST MODE plan upgrade: solo -> team6 updates the row + logs event.
  reset([company(1, 'solo')], [sub(1, 'trialing')], [user(1, 1)]);
  const up = await billing.changePlan(1, 'team6');
  assert.strictEqual(up.id, 'team6');
  assert.strictEqual(state.companies[0].plan_tier, 'team6');
  assert.ok(state.events.some((e) => e.type === 'plan_changed' && /Team · up to 6/.test(e.detail)));

  // 2. Downgrade below headcount is refused, naming users and seats.
  reset([company(2, 'team6')], [sub(2, 'active')], [user(1, 2), user(2, 2), user(3, 2), user(4, 2)]);
  await assert.rejects(() => billing.changePlan(2, 'team3'), /4 active users.*3 seats/);
  assert.strictEqual(state.companies[0].plan_tier, 'team6');

  // 3. Downgrade at/above headcount succeeds; deactivated users free seats.
  reset([company(3, 'team6')], [sub(3, 'active')], [user(1, 3), user(2, 3), user(3, 3, false), user(4, 3, false)]);
  const down = await billing.changePlan(3, 'team3');
  assert.strictEqual(down.id, 'team3');
  assert.strictEqual(state.companies[0].plan_tier, 'team3');

  // 4. Canceled subscriptions cannot switch plans.
  reset([company(4, 'solo')], [sub(4, 'canceled')], [user(1, 4)]);
  await assert.rejects(() => billing.changePlan(4, 'team3'), /canceled/);

  // 5. Webhook subscription.updated syncs tier from a known price id.
  reset([company(5, 'solo')], [sub(5, 'trialing', { stripe_customer_id: 'cus_test_5' })], [user(1, 5)]);
  const ok = await billing.applyStripeEvent({
    type: 'customer.subscription.updated',
    data: { object: { id: 'sub_test_5', customer: 'cus_test_5', status: 'active', current_period_end: Math.floor(Date.now() / 1000) + 2592000, items: { data: [{ price: { id: 'price_test_team10' } }] } } },
  });
  assert.strictEqual(ok, true);
  assert.strictEqual(state.companies[0].plan_tier, 'team10');
  assert.strictEqual(state.subs[0].status, 'active');
  assert.ok(state.events.some((e) => e.type === 'plan_synced'));

  // 6. Webhook with an unknown price leaves the tier untouched, no crash.
  reset([company(6, 'team3')], [sub(6, 'active', { stripe_customer_id: 'cus_test_6' })], [user(1, 6)]);
  await billing.applyStripeEvent({
    type: 'customer.subscription.updated',
    data: { object: { id: 'sub_test_6', customer: 'cus_test_6', status: 'active', items: { data: [{ price: { id: 'price_unknown_legacy' } }] } } },
  });
  assert.strictEqual(state.companies[0].plan_tier, 'team3');

  // 7. Checkout with a tier whose price is unset fails fast, before Stripe.
  reset([company(7, 'solo')], [sub(7, 'trialing')], [user(1, 7)]);
  delete process.env.STRIPE_PRICE_TIER_3;
  await assert.rejects(
    () => billing.createCheckoutSession({ id: 7, name: 'Co 7', plan_tier: 'team3' }, { email: 'o@co.test' }),
    /No Stripe price is configured for the Team · up to 3 plan/
  );
  process.env.STRIPE_PRICE_TIER_3 = 'price_test_team3';

  console.log('billing-tiers.test.js PASS');
})().catch((e) => {
  console.error('billing-tiers.test.js FAIL:', e);
  process.exit(1);
});
