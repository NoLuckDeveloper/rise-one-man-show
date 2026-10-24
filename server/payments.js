'use strict';
// Invoice payments: Stripe Connect (direct charges to each company's own
// Stripe account), the public pay-link plumbing, and payment-state writes.
//
// Invoices are derived from call chains (see invoiceFor in server/index.js);
// payment state lives on the chain's root call row. All functions here take
// already company-scoped rows — callers are responsible for scoping lookups
// by company_id (the public pay page scopes by the unguessable pay_token).
const crypto = require('crypto');
const db = require('./db');
const billing = require('./billing');

function baseUrl() {
  return (process.env.APP_BASE_URL || 'http://localhost:3000').replace(/\/$/, '');
}

function payUrl(rootCall) {
  return `${baseUrl()}/pay/${rootCall.pay_token}`;
}

function isSimulatedAccount(accountId) {
  return typeof accountId === 'string' && accountId.startsWith('acct_test_');
}

// Lazily assign the root call an unguessable pay token (stable across calls).
// Retries once on the (astronomically unlikely) unique-index collision.
async function ensurePayToken(rootCall) {
  if (rootCall.pay_token) return rootCall.pay_token;
  for (let attempt = 0; attempt < 2; attempt++) {
    const token = crypto.randomBytes(24).toString('base64url');
    try {
      await db.q('UPDATE calls SET pay_token = $1 WHERE id = $2 AND pay_token IS NULL', [token, rootCall.id]);
      const fresh = await db.one('SELECT pay_token FROM calls WHERE id = $1', [rootCall.id]);
      rootCall.pay_token = fresh.pay_token;
      return rootCall.pay_token;
    } catch (e) {
      if (e.code !== '23505' || attempt === 1) throw e; // unique_violation
    }
  }
  return rootCall.pay_token;
}

// Idempotent: only the first payment recorded wins; later calls are no-ops.
async function markInvoicePaid(rootCallId, { method, reference, paidAt }) {
  const r = await db.q(
    `UPDATE calls SET payment_status = 'paid', payment_method = $2, payment_reference = $3, paid_at = $4
      WHERE id = $1 AND payment_status = 'unpaid'`,
    [rootCallId, method, reference || null, paidAt || new Date()]
  );
  return r.rowCount > 0;
}

// --- Stripe Connect ----------------------------------------------------------

async function createExpressAccount(company, ownerUser) {
  const account = await billing.stripe.accounts.create({
    type: 'express',
    email: ownerUser.email,
    capabilities: {
      card_payments: { requested: true },
      transfers: { requested: true },
    },
    metadata: { company_id: String(company.id) },
  });
  return account;
}

async function createOnboardingLink(accountId) {
  const link = await billing.stripe.accountLinks.create({
    account: accountId,
    refresh_url: `${baseUrl()}/app/settings/connect/refresh`,
    return_url: `${baseUrl()}/app/settings/connect/return`,
    type: 'account_onboarding',
  });
  return link;
}

// Re-read the connected account and persist whether charges are enabled.
async function refreshConnectStatus(settings) {
  const account = await billing.stripe.accounts.retrieve(settings.stripe_account_id);
  const enabled = !!account.charges_enabled;
  if (enabled !== !!settings.stripe_charges_enabled) {
    await db.q('UPDATE company_settings SET stripe_charges_enabled = $1 WHERE company_id = $2',
      [enabled, settings.company_id]);
    settings.stripe_charges_enabled = enabled;
  }
  return account;
}

// Checkout Session as a DIRECT CHARGE on the company's connected account:
// the money settles to the company, never to the platform.
async function createInvoiceCheckout({ company, settings, rootCall, inv }) {
  const session = await billing.stripe.checkout.sessions.create(
    {
      mode: 'payment',
      line_items: [{
        price_data: {
          currency: 'usd',
          product_data: {
            name: `Invoice from ${company.name}`,
            description: rootCall.description || undefined,
          },
          unit_amount: inv.totalCents,
        },
        quantity: 1,
      }],
      success_url: `${baseUrl()}/pay/${rootCall.pay_token}?paid=1&session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${baseUrl()}/pay/${rootCall.pay_token}`,
      metadata: { root_call_id: String(rootCall.id), company_id: String(company.id) },
    },
    { stripeAccount: settings.stripe_account_id }
  );
  return session;
}

// Fallback verification for the pay-page success return, in case the Connect
// webhook destination is not configured yet: fetch the session on the
// connected account and record the payment if Stripe says it is paid.
async function verifyCheckoutSession({ settings, rootCall, sessionId }) {
  const session = await billing.stripe.checkout.sessions.retrieve(sessionId, {}, { stripeAccount: settings.stripe_account_id });
  if (session.payment_status !== 'paid') return false;
  if (!session.metadata || String(session.metadata.root_call_id) !== String(rootCall.id)) return false;
  return markInvoicePaid(rootCall.id, {
    method: 'card',
    reference: session.payment_intent || session.id,
    paidAt: new Date(),
  });
}

// Connect webhook events (delivered on the *connected account* destination,
// so event.account is set). Only checkout completion is needed: the session
// metadata points back at the invoice's root call.
async function applyConnectEvent(event) {
  if (event.type !== 'checkout.session.completed') return false;
  const session = event.data && event.data.object;
  if (!session || session.payment_status !== 'paid') return false;
  const rootCallId = Number(session.metadata && session.metadata.root_call_id);
  if (!rootCallId) return false;
  const root = await db.one('SELECT id FROM calls WHERE id = $1', [rootCallId]);
  if (!root) return false;
  await markInvoicePaid(rootCallId, {
    method: 'card',
    reference: session.payment_intent || session.id,
    paidAt: new Date(),
  });
  return true;
}

module.exports = {
  baseUrl, payUrl, isSimulatedAccount, ensurePayToken, markInvoicePaid,
  createExpressAccount, createOnboardingLink, refreshConnectStatus,
  createInvoiceCheckout, verifyCheckoutSession, applyConnectEvent,
};
