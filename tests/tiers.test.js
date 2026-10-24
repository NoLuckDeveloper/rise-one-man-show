'use strict';
// Pure tier-definition tests. No DB, no Stripe.
const assert = require('node:assert');
const tiers = require('../server/tiers');

const { TIERS, tierById, priceIdForTier, tierForPriceId, availableTiers, perUserCents, computeMrr, tierBreakdown } = tiers;

assert.strictEqual(TIERS.length, 4);
assert.deepStrictEqual(TIERS.map((t) => t.id), ['solo', 'team3', 'team6', 'team10']);
assert.deepStrictEqual(TIERS.map((t) => t.seats), [1, 3, 6, 10]);
assert.deepStrictEqual(TIERS.map((t) => t.monthlyCents), [1099, 2849, 4799, 6499]);

// Per-user rates land on the approved $10.99 / $9.50 / $8.00 / $6.50.
assert.deepStrictEqual(TIERS.map(perUserCents), [1099, 950, 800, 650]);

// Unknown ids fall back to solo — never crash billing on a bad row.
assert.strictEqual(tierById('nope').id, 'solo');
assert.strictEqual(tierById(undefined).id, 'solo');

// Price-id mapping uses env var NAMES only; tests use obvious fakes.
process.env.STRIPE_PRICE_ID = 'price_test_solo';
process.env.STRIPE_PRICE_TIER_3 = 'price_test_team3';
process.env.STRIPE_PRICE_TIER_6 = 'price_test_team6';
process.env.STRIPE_PRICE_TIER_10 = 'price_test_team10';
assert.strictEqual(priceIdForTier(tierById('team6')), 'price_test_team6');
assert.strictEqual(tierForPriceId('price_test_team10').id, 'team10');
assert.strictEqual(tierForPriceId('price_unknown'), null);
assert.strictEqual(tierForPriceId(null), null);

// TEST MODE offers every tier; live mode hides tiers with no price set.
assert.strictEqual(availableTiers(true).length, 4);
delete process.env.STRIPE_PRICE_TIER_6;
assert.deepStrictEqual(availableTiers(false).map((t) => t.id), ['solo', 'team3', 'team10']);
process.env.STRIPE_PRICE_TIER_6 = 'price_test_team6';

// MRR counts trialing + active only, at each company's tier rate.
const companies = [
  { plan_tier: 'solo', sub_status: 'active' },
  { plan_tier: 'team3', sub_status: 'trialing' },
  { plan_tier: 'team10', sub_status: 'active' },
  { plan_tier: 'team6', sub_status: 'canceled' },
  { plan_tier: 'solo', sub_status: 'past_due' },
  { plan_tier: 'solo', sub_status: 'trial_ended' },
  { plan_tier: 'mystery', sub_status: 'active' }, // unknown tier -> solo rate
];
assert.strictEqual(computeMrr(companies), 1099 + 2849 + 6499 + 1099);
assert.deepStrictEqual(
  tierBreakdown(companies).map((b) => [b.tier.id, b.count]),
  [['solo', 2], ['team3', 1], ['team6', 0], ['team10', 1]]
);
assert.strictEqual(computeMrr([]), 0);

console.log('tiers.test.js PASS');
