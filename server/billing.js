'use strict';
// Billing: Stripe when the env vars are present, otherwise a clearly
// labeled TEST MODE that simulates the same lifecycle (trialing -> active /
// trial_ended, past_due, retry) so the app is fully usable without Stripe.
const { one, q, billingEvent } = require('./db');
const tiers = require('./tiers');

const STRIPE_KEYS = ['STRIPE_SECRET_KEY', 'STRIPE_PUBLISHABLE_KEY', 'STRIPE_PRICE_ID', 'STRIPE_WEBHOOK_SECRET'];
const TEST_MODE = STRIPE_KEYS.some((k) => !process.env[k]);

let stripe = null;
if (!TEST_MODE) {
  stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
}

function baseUrl() {
  return (process.env.APP_BASE_URL || 'http://localhost:3000').replace(/\/$/, '');
}

async function getSubscription(companyId) {
  return one('SELECT * FROM subscriptions WHERE company_id = $1', [companyId]);
}

async function setStatus(companyId, status, extra = {}) {
  const fields = ['status = $2', 'updated_at = now()'];
  const params = [companyId, status];
  for (const [k, v] of Object.entries(extra)) {
    params.push(v);
    fields.push(`${k} = $${params.length}`);
  }
  await q(`UPDATE subscriptions SET ${fields.join(', ')} WHERE company_id = $1`, params);
}

// Lazy lifecycle pass, run on each authenticated request.
// - TEST MODE: converts an expired trial locally (card on file -> active,
//   no card -> trial_ended) and rolls active periods forward.
// - Stripe mode: local state is driven by webhooks; this only mirrors the
//   subscription status from Stripe when a trial has expired locally, as a
//   safety net if a webhook was missed.
async function refreshState(companyId) {
  const sub = await getSubscription(companyId);
  if (!sub) return null;
  const now = new Date();

  if (sub.status === 'trialing' && new Date(sub.trial_end) <= now) {
    if (!TEST_MODE && sub.stripe_subscription_id && stripe) {
      try {
        const remote = await stripe.subscriptions.retrieve(sub.stripe_subscription_id);
        const mapped = mapStripeStatus(remote.status);
        await setStatus(companyId, mapped, {
          current_period_end: remote.current_period_end ? new Date(remote.current_period_end * 1000) : sub.current_period_end,
        });
        await billingEvent(companyId, 'stripe_sync', `Trial ended; Stripe status: ${remote.status}`);
        return getSubscription(companyId);
      } catch (e) {
        console.error('[billing] Stripe sync failed', e.message);
      }
    }
    if (TEST_MODE) {
      if (sub.payment_last4) {
        const periodEnd = new Date(now.getTime() + 30 * 86400000);
        await setStatus(companyId, 'active', { current_period_end: periodEnd });
        await billingEvent(companyId, 'trial_converted', 'Trial ended with a payment method on file (test mode) — subscription active.');
      } else {
        await setStatus(companyId, 'trial_ended');
        await billingEvent(companyId, 'trial_ended', 'Trial ended with no payment method (test mode) — app locked to billing.');
      }
      return getSubscription(companyId);
    }
  }

  if (TEST_MODE && sub.status === 'active' && sub.current_period_end && new Date(sub.current_period_end) <= now) {
    const periodEnd = new Date(now.getTime() + 30 * 86400000);
    await setStatus(companyId, 'active', { current_period_end: periodEnd });
    await billingEvent(companyId, 'renewed', 'Monthly period rolled forward (test mode).');
    return getSubscription(companyId);
  }

  return sub;
}

function mapStripeStatus(s) {
  switch (s) {
    case 'trialing': return 'trialing';
    case 'active': return 'active';
    case 'past_due': return 'past_due';
    case 'canceled': return 'canceled';
    case 'unpaid': return 'past_due';
    case 'incomplete_expired': return 'trial_ended';
    default: return 'active';
  }
}

// --- Stripe mode -----------------------------------------------------------

async function ensureCustomer(company, user) {
  const sub = await getSubscription(company.id);
  if (sub.stripe_customer_id) return sub.stripe_customer_id;
  const customer = await stripe.customers.create({
    name: company.name,
    email: user.email,
    metadata: { company_id: String(company.id) },
  });
  await setStatus(company.id, sub.status, { stripe_customer_id: customer.id });
  return customer.id;
}

async function createCheckoutSession(company, user, tierId) {
  const sub = await getSubscription(company.id);
  const tier = tiers.tierById(tierId || company.plan_tier);
  const priceId = tiers.priceIdForTier(tier);
  if (!priceId) throw new Error(`No Stripe price is configured for the ${tier.label} plan yet — add ${tier.priceEnv} to the server environment.`);
  const customerId = await ensureCustomer(company, user);
  const remainingTrialDays = Math.max(0, Math.ceil((new Date(sub.trial_end) - Date.now()) / 86400000));
  const session = await stripe.checkout.sessions.create({
    mode: 'subscription',
    customer: customerId,
    line_items: [{ price: priceId, quantity: 1 }],
    subscription_data: remainingTrialDays > 0 ? { trial_period_days: remainingTrialDays } : {},
    success_url: `${baseUrl()}/app/billing?checkout=success`,
    cancel_url: `${baseUrl()}/app/billing?checkout=cancel`,
    metadata: { company_id: String(company.id) },
  });
  return session.url;
}

async function countActiveUsers(companyId) {
  const row = await one('SELECT COUNT(*)::int AS n FROM users WHERE company_id = $1 AND active = TRUE', [companyId]);
  return row ? row.n : 0;
}

// Switch a company's plan. Works both directions: upgrades and downgrades
// go through this one endpoint, and Stripe prorates the change immediately
// (proration_behavior 'create_prorations'). Two guards:
// - downgrading below the current active headcount is refused — the company
//   must remove users first, so a switch can never strand users over cap;
// - a canceled subscription cannot switch (it must be reactivated first).
// TEST MODE simulates the switch locally (no Stripe calls).
async function changePlan(companyId, tierId) {
  const tier = tiers.tierById(tierId);
  const sub = await getSubscription(companyId);
  if (!sub) throw new Error('No subscription found for this company.');
  if (sub.status === 'canceled') throw new Error('This subscription is canceled — reactivate it before switching plans.');
  const headcount = await countActiveUsers(companyId);
  if (tier.seats < headcount) {
    throw new Error(`Cannot switch to ${tier.label}: your company has ${headcount} active user${headcount === 1 ? '' : 's'}, more than the ${tier.seats} seat${tier.seats === 1 ? '' : 's'} on that plan. Remove users first, then switch.`);
  }
  if (!TEST_MODE) {
    if (!sub.stripe_subscription_id) throw new Error('No Stripe subscription yet — add a payment method first, then switch plans.');
    const remote = await stripe.subscriptions.retrieve(sub.stripe_subscription_id);
    const item = remote.items && remote.items.data && remote.items.data[0];
    if (!item) throw new Error('Could not find the subscription item to update in Stripe.');
    const priceId = tiers.priceIdForTier(tier);
    if (!priceId) throw new Error(`No Stripe price is configured for the ${tier.label} plan yet — add ${tier.priceEnv} to the server environment.`);
    await stripe.subscriptions.update(sub.stripe_subscription_id, {
      items: [{ id: item.id, price: priceId }],
      proration_behavior: 'create_prorations',
    });
  }
  await q('UPDATE companies SET plan_tier = $2 WHERE id = $1', [companyId, tier.id]);
  await billingEvent(companyId, 'plan_changed', `Plan switched to ${tier.label} (${tier.seats} seat${tier.seats === 1 ? '' : 's'}).`);
  return tier;
}

async function createPortalSession(company) {
  const sub = await getSubscription(company.id);
  if (!sub.stripe_customer_id) return null;
  const session = await stripe.billingPortal.sessions.create({
    customer: sub.stripe_customer_id,
    return_url: `${baseUrl()}/app/billing`,
  });
  return session.url;
}

// Apply a Stripe webhook event to local state. Returns true if handled.
async function applyStripeEvent(event) {
  const obj = event.data && event.data.object;
  if (!obj) return false;
  let customerId = obj.customer || null;
  if (event.type.startsWith('customer.subscription') && obj.customer) customerId = obj.customer;
  if (!customerId && obj.id && event.type.startsWith('customer.subscription')) customerId = obj.customer;
  if (!customerId) return false;
  const sub = await one('SELECT * FROM subscriptions WHERE stripe_customer_id = $1', [customerId]);
  if (!sub) return false;

  if (event.type.startsWith('customer.subscription')) {
    const mapped = mapStripeStatus(obj.status);
    await setStatus(sub.company_id, mapped, {
      stripe_subscription_id: obj.id,
      current_period_end: obj.current_period_end ? new Date(obj.current_period_end * 1000) : sub.current_period_end,
      trial_end: obj.trial_end ? new Date(obj.trial_end * 1000) : sub.trial_end,
    });
    // Sync the plan tier from the subscription's price id. An unknown
    // price (e.g. a legacy or hand-made price) leaves the tier unchanged
    // rather than guessing — and a sync failure must never break the
    // webhook response, so it is isolated in its own try/catch.
    try {
      const item = obj.items && obj.items.data && obj.items.data[0];
      const tier = tiers.tierForPriceId(item && item.price && item.price.id);
      if (tier) {
        await q('UPDATE companies SET plan_tier = $2 WHERE id = $1', [sub.company_id, tier.id]);
        await billingEvent(sub.company_id, 'plan_synced', `Plan tier synced from Stripe price to ${tier.label}.`);
      }
    } catch (e) {
      console.error('[billing] plan tier sync failed', e.message);
    }
    await billingEvent(sub.company_id, event.type, `Stripe subscription ${obj.id} -> ${obj.status}`);
    return true;
  }
  if (event.type === 'invoice.payment_failed') {
    await setStatus(sub.company_id, 'past_due');
    await billingEvent(sub.company_id, event.type, 'Invoice payment failed — subscription past due.');
    return true;
  }
  if (event.type === 'invoice.paid') {
    if (sub.status === 'past_due' || sub.status === 'trialing') {
      await setStatus(sub.company_id, 'active', {
        current_period_end: obj.period_end ? new Date(obj.period_end * 1000) : sub.current_period_end,
      });
    }
    await billingEvent(sub.company_id, event.type, 'Invoice paid.');
    return true;
  }
  return false;
}

module.exports = { TEST_MODE, stripe, getSubscription, setStatus, refreshState, createCheckoutSession, createPortalSession, applyStripeEvent, mapStripeStatus, changePlan, countActiveUsers, tiers };
