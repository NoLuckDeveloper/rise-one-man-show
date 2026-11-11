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

// Free access: billing page shows the grant and hides plan switching;
// platform page counts the free company and offers removal, not a trial.
const freeSub = { status: 'free', trial_start: new Date(), trial_end: new Date(), current_period_end: null, payment_last4: null, payment_brand: null };
const freeBilling = views.billingPage({ user, sub: freeSub, company, flash: null, events: [], checkoutState: null, tier: tiers.tierById('solo'), seatUsed: 1 });
assert.ok(freeBilling.includes('Free access'), 'billing missing free access copy');
assert.ok(freeBilling.includes('unlimited'), 'billing missing unlimited copy');
assert.ok(!freeBilling.includes('action="/app/billing/plan-change"'), 'billing still offers plan switch to a free company');
assert.ok(freeBilling.includes('never expires'), 'billing missing never-expires copy');

const freePlatform = views.platformPage({
  user: { role: 'platform' }, flash: null, demoId: null,
  companies: [{ id: 2, name: 'B', created_at: new Date(), user_count: 1, sub_status: 'free', plan_tier: 'solo', trial_end: new Date() }],
  totals: { companies: 1, trialing: 0, active: 0, free: 1, mrrCents: 0, breakdown: tiers.tierBreakdown([{ plan_tier: 'solo', sub_status: 'free' }]) },
});
assert.ok(freePlatform.includes('Free: <strong>1</strong>'), 'platform missing free count');
assert.ok(freePlatform.includes('Remove free access'), 'platform missing remove-free button');
assert.ok(freePlatform.includes('Free access (unlimited)'), 'platform missing free label');
assert.ok(freePlatform.includes('action="/platform/companies/2/remove-free"'), 'platform missing remove-free action');
assert.ok(!freePlatform.includes('Make free (unlimited)'), 'platform still offers make-free on a free company');

const freeUsers = views.usersPage({ user, sub: freeSub, company, flash: null, users: [{ id: 1, name: 'O', email: 'o@x', role: 'owner', active: true }], tier: tiers.tierById('solo'), seatUsed: 1 });
assert.ok(freeUsers.includes('unlimited seats (free access)'), 'users missing unlimited seats copy');
assert.ok(!freeUsers.includes('Seat limit reached'), 'users still warns at cap for a free company');

// Price book: the page lists saved parts with edit/delete actions, and the
// job report offers a picker that carries the part's cost.
const bookItems = [{ id: 7, name: 'Panic bar', part_number: '98E', description: 'Von Duprin exit device', cost_cents: 4599 }];
const bookPage = views.priceBookPage({ user, sub, company, flash: null, items: bookItems, query: '' });
assert.ok(bookPage.includes('Price Book'), 'price book missing title');
assert.ok(bookPage.includes('Panic bar'), 'price book missing item name');
assert.ok(bookPage.includes('98E'), 'price book missing part number');
assert.ok(bookPage.includes('action="/app/price-book/7/edit"'), 'price book missing edit action');
assert.ok(bookPage.includes('action="/app/price-book/7/delete"'), 'price book missing delete action');

const reportHtml = views.reportPage({ user, sub, company, flash: null, call: { id: 3 }, report: null, chainHours: 0, chainMiles: 0, print: false, priceBook: bookItems });
assert.ok(reportHtml.includes('id="price-book-pick"'), 'report missing price book picker');
assert.ok(reportHtml.includes('data-cost="45.99"'), 'report picker missing cost');
assert.ok(reportHtml.includes('Panic bar'), 'report picker missing part name');
const reportNoBook = views.reportPage({ user, sub, company, flash: null, call: { id: 3 }, report: null, chainHours: 0, chainMiles: 0, print: false, priceBook: [] });
assert.ok(!reportNoBook.includes('id="price-book-pick"'), 'report shows picker with an empty price book');

console.log('views-tiers.test.js PASS');
