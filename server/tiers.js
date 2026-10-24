'use strict';
// Subscription tiers — the single source of truth for pricing, used by
// billing, signup, the billing page, and platform admin. No other file
// should hardcode a plan price or a seat cap.
//
// Prices are monthly, per company, in USD cents. Seat caps count TOTAL
// active users in the company, not role slots — any mix of owner/admin/
// tech fits within the cap. Every tier includes the 7-day free trial and
// may be switched to at any time (plan changes are prorated by Stripe).
const TIERS = [
  { id: 'solo',   label: 'Solo',            seats: 1,  monthlyCents: 1099, priceEnv: 'STRIPE_PRICE_ID' },
  { id: 'team3',  label: 'Team · up to 3',  seats: 3,  monthlyCents: 2849, priceEnv: 'STRIPE_PRICE_TIER_3' },
  { id: 'team6',  label: 'Team · up to 6',  seats: 6,  monthlyCents: 4799, priceEnv: 'STRIPE_PRICE_TIER_6' },
  { id: 'team10', label: 'Team · up to 10', seats: 10, monthlyCents: 6499, priceEnv: 'STRIPE_PRICE_TIER_10' },
];

// Unknown or missing tier ids fall back to solo, so an old or corrupt row
// can never break billing or lock a company out of the app.
function tierById(id) {
  return TIERS.find((t) => t.id === id) || TIERS[0];
}

// The Stripe price id configured for a tier, or null when its env var is
// unset (expected in TEST MODE, where prices are simulated).
function priceIdForTier(tier) {
  return process.env[tier.priceEnv] || null;
}

// The tier whose configured price id matches, or null for unknown prices.
// Unknown prices must never change a company's tier (see webhook sync).
function tierForPriceId(priceId) {
  if (!priceId) return null;
  return TIERS.find((t) => process.env[t.priceEnv] && process.env[t.priceEnv] === priceId) || null;
}

// Tiers a new signup may pick. In TEST MODE all tiers are offered (prices
// are simulated); live, only tiers with a configured Stripe price are
// offered, so nobody can check out on a plan that has no price yet.
function availableTiers(testMode) {
  return testMode ? TIERS : TIERS.filter((t) => priceIdForTier(t));
}

// Per-user monthly rate in cents, rounded: 1099 / 950 / 800 / 650.
function perUserCents(tier) {
  return Math.round(tier.monthlyCents / tier.seats);
}

// MRR in cents across companies whose subscription is trialing or active.
// Companies with any other status (past_due, canceled, trial_ended) do not
// count — MRR is money actually expected, not seats ever sold.
function computeMrr(companies) {
  return (companies || [])
    .filter((c) => c.sub_status === 'trialing' || c.sub_status === 'active')
    .reduce((sum, c) => sum + tierById(c.plan_tier).monthlyCents, 0);
}

// Per-tier company counts for the same trialing/active population, in tier
// order, including tiers with zero companies (so the admin view is stable).
function tierBreakdown(companies) {
  const counts = new Map(TIERS.map((t) => [t.id, 0]));
  for (const c of companies || []) {
    if (c.sub_status !== 'trialing' && c.sub_status !== 'active') continue;
    counts.set(tierById(c.plan_tier).id, (counts.get(tierById(c.plan_tier).id) || 0) + 1);
  }
  return TIERS.map((t) => ({ tier: t, count: counts.get(t.id) || 0 }));
}

module.exports = { TIERS, tierById, priceIdForTier, tierForPriceId, availableTiers, perUserCents, computeMrr, tierBreakdown };
