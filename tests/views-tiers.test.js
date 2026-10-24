'use strict';
// Rendered-copy tests: landing, signup, billing, users, and platform pages
// must show tiers, never the old flat "$10.99 per company" claim. No DB
// queries run here (views only render), but views requires billing, which
// requires pg — the pool is created, never connected.
const assert = require('node:assert');
const views = require('../server/views');
const tiers = require('../server/tiers');

const company = { id: 1, name: 'Acme Doors', plan_tier: 'team3' };
const sub = { status: 'trialing', trial_start: new Date(), trial_end: new Date(Date.now() + 5 * 86400000), current_period_end: null, payment_last4: null, payment_brand: null };
const user = { id: 1, role: 'owner' };

const landing = views.landingPage(null);
for (const [label, price] of [['Solo', '$10.99'], ['Team · up to 3', '$28.49'], ['Team · up to 6', '$47.99'], ['Team · up to 10', '$64.99']]) {
  assert.ok(landing.includes(label), `landing missing ${label}`);
  assert.ok(landing.includes(price), `landing missing ${price}`);
}
assert.ok(!landing.includes('$10.99/month</strong> per company'), 'landing still shows flat pricing');

const signup = views.signupPage(null, tiers.TIERS);
for (const t of tiers.TIERS) {
  assert.ok(signup.includes(`name="plan_tier" value="${t.id}"`), `signup missing radio ${t.id}`);
}
assert.ok(signup.includes('value="solo" checked'), 'signup does not default to solo');

const billingHtml = views.billingPage({ user, sub, company, flash: null, events: [], checkoutState: null, tier: tiers.tierById('team3'), seatUsed: 2 });
assert.ok(billingHtml.includes('Team · up to 3'), 'billing missing tier label');
assert.ok(billingHtml.includes('$28.49/month'), 'billing missing tier price');
assert.ok(billingHtml.includes('2 of 3'), 'billing missing seat usage');
for (const id of ['solo', 'team6', 'team10']) {
  assert.ok(billingHtml.includes(`action="/app/billing/plan-change"`) && billingHtml.includes(`value="${id}"`), `billing missing switch to ${id}`);
}
assert.ok(!billingHtml.includes('flat, not per user'), 'billing still shows flat copy');

const usersHtml = views.usersPage({ user, sub, company, flash: null, users: [{ id: 1, name: 'O', email: 'o@x', role: 'owner', active: true }], tier: tiers.tierById('solo'), seatUsed: 1 });
assert.ok(usersHtml.includes('1 of 1 used'), 'users missing seat usage');
assert.ok(usersHtml.includes('Seat limit reached'), 'users missing at-cap warning');

const platformHtml = views.platformPage({
  user: { role: 'platform' }, flash: null, demoId: null,
  companies: [{ id: 1, name: 'A', created_at: new Date(), user_count: 1, sub_status: 'active', plan_tier: 'team6', trial_end: null }],
  totals: { companies: 1, trialing: 0, active: 1, mrrCents: 4799, breakdown: tiers.tierBreakdown([{ plan_tier: 'team6', sub_status: 'active' }]) },
});
assert.ok(platformHtml.includes('$47.99'), 'platform MRR not tier-based');
assert.ok(platformHtml.includes('Team · up to 6'), 'platform missing tier breakdown');
assert.ok(!platformHtml.includes('active * 1099'), 'platform still shows old MRR math');

console.log('views-tiers.test.js PASS');
