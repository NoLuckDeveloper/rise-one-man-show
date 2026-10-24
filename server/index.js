'use strict';
const path = require('path');
const express = require('express');
const db = require('./db');
const auth = require('./auth');
const billing = require('./billing');
const payments = require('./payments');
const mailer = require('./mailer');
const views = require('./views');
const { esc, dollarsToCents, hoursBetween, computeInvoice, isoDate } = require('./util');

const app = express();

// Stripe webhook needs the raw body for signature verification — register it
// BEFORE any body parsers. Two event families arrive here:
// - platform billing events (no event.account) -> STRIPE_WEBHOOK_SECRET
// - Connect events from companies' own accounts (event.account set, sent to
//   the Connected-accounts destination) -> STRIPE_CONNECT_WEBHOOK_SECRET,
//   falling back to the platform secret. The account field is peeked from
//   the unverified payload ONLY to choose which secret verifies it.
app.post('/webhooks/stripe', express.raw({ type: 'application/json' }), async (req, res) => {
  if (billing.TEST_MODE || !billing.stripe) return res.json({ received: true, testMode: true });
  let peek = {};
  try { peek = JSON.parse(req.body.toString('utf8')); } catch (e) { /* verification below will fail cleanly */ }
  const secret = peek.account
    ? (process.env.STRIPE_CONNECT_WEBHOOK_SECRET || process.env.STRIPE_WEBHOOK_SECRET)
    : process.env.STRIPE_WEBHOOK_SECRET;
  const sig = req.headers['stripe-signature'];
  let event;
  try {
    event = billing.stripe.webhooks.constructEvent(req.body, sig, secret);
  } catch (e) {
    console.error('[stripe] webhook signature failed:', e.message);
    return res.status(400).send('Invalid signature');
  }
  try {
    if (event.account) await payments.applyConnectEvent(event);
    else await billing.applyStripeEvent(event);
  } catch (e) {
    console.error('[stripe] webhook handling failed:', e.message);
  }
  res.json({ received: true });
});

app.use(express.urlencoded({ extended: true, limit: '15mb' }));
app.use(express.json({ limit: '15mb' }));
app.use(express.static(path.join(__dirname, '..', 'public')));
app.use(auth.loadSession);

const LOCKED_STATUSES = ['trial_ended', 'canceled'];

function flashFrom(req) {
  if (req.query.err) return { msg: req.query.err, kind: 'err' };
  if (req.query.msg) return { msg: req.query.msg, kind: 'ok' };
  return null;
}
const back = (res, url, kind, msg) => res.redirect(`${url}${url.includes('?') ? '&' : '?'}${kind}=${encodeURIComponent(msg)}`);

// Loads company + subscription for company users and enforces the
// trial-ended / canceled lock (billing page only).
async function companyContext(req, res, next) {
  try {
    if (!req.user || req.user.role === 'platform') return res.redirect('/platform');
    req.company = await db.one('SELECT * FROM companies WHERE id = $1', [req.companyId]);
    if (!req.company) return res.redirect('/login');
    req.sub = await billing.refreshState(req.companyId);
    req.settings = await db.one('SELECT * FROM company_settings WHERE company_id = $1', [req.companyId]);
    if (req.sub && LOCKED_STATUSES.includes(req.sub.status)) {
      // NOTE: req.path is mount-relative inside app.use('/app', ...) — use originalUrl.
      const fullPath = req.originalUrl.split('?')[0];
      const ok = fullPath.startsWith('/app/billing') || fullPath === '/logout';
      if (!ok) return res.redirect('/app/billing?err=' + encodeURIComponent('Your subscription is not active — add a payment method to continue.'));
    }
    next();
  } catch (e) { next(e); }
}

async function chainCalls(call) {
  const rootId = call.root_call_id || call.id;
  const rows = await db.many(
    'SELECT * FROM calls WHERE company_id = $1 AND (id = $2 OR root_call_id = $2) ORDER BY id',
    [call.company_id, rootId]
  );
  return { rootId, calls: rows };
}

async function chainTotals(companyId, callIds) {
  if (!callIds.length) return { hours: 0, miles: 0, parts: [] };
  const punches = await db.many('SELECT * FROM punches WHERE company_id = $1 AND call_id = ANY($2)', [companyId, callIds]);
  const hours = punches.reduce((s, p) => s + hoursBetween(p.clock_in, p.clock_out || new Date().toISOString()), 0);
  const trips = await db.many('SELECT COALESCE(SUM(miles),0) AS m FROM trips WHERE company_id = $1 AND call_id = ANY($2)', [companyId, callIds]);
  const reports = await db.many('SELECT parts FROM job_reports WHERE company_id = $1 AND call_id = ANY($2)', [companyId, callIds]);
  const parts = reports.flatMap((r) => (Array.isArray(r.parts) ? r.parts : []));
  return { hours, miles: Number(trips[0].m || 0), parts };
}

// Invoice is ready when the chain's leaf call has a complete report with no
// follow-up pending; it then bills the whole chain.
async function invoiceFor(call) {
  const { calls } = await chainCalls(call);
  const leaf = calls[calls.length - 1];
  const leafReport = await db.one('SELECT * FROM job_reports WHERE call_id = $1', [leaf.id]);
  if (!leafReport || !leafReport.complete || leafReport.follow_up) return null;
  const totals = await chainTotals(call.company_id, calls.map((c) => c.id));
  const settings = await db.one('SELECT * FROM company_settings WHERE company_id = $1', [call.company_id]);
  const inv = computeInvoice({
    hours: totals.hours,
    parts: totals.parts,
    hourlyRateCents: settings.hourly_rate_cents,
    taxPercent: Number(settings.tax_percent),
    partsMultiplier: Number(settings.parts_multiplier),
  });
  const root = calls[0];
  return { inv, root, leaf, settings };
}

// --- Customer email records + invoice delivery -------------------------------
function normalizeEmail(value) {
  const email = String(value || '').trim().toLowerCase();
  return email || null;
}

function isEmail(value) {
  return !!value && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);
}

async function getCustomerRecord(companyId, customerName) {
  if (!customerName) return null;
  return db.one('SELECT * FROM customers WHERE company_id = $1 AND customer_name = $2', [companyId, customerName]);
}

// Capture point used by call create/edit (and follow-up creation): a
// non-empty email on any call becomes that customer's email on file. An
// empty call email does not erase a customer-level address.
async function syncCustomerEmail(companyId, customerName, emailValue) {
  const email = normalizeEmail(emailValue);
  if (!customerName || !email) return null;
  return db.one(
    `INSERT INTO customers (company_id, customer_name, email)
     VALUES ($1, $2, $3)
     ON CONFLICT (company_id, customer_name)
     DO UPDATE SET email = EXCLUDED.email, updated_at = now()
     RETURNING *`,
    [companyId, customerName, email]
  );
}

// The customer-level address on file (if any), with a caller-supplied
// fallback. Used for invoice recipients and system-created follow-up calls
// so a customer-page edit is not clobbered by a stale email stored on an
// older call.
async function customerEmailOnFile(companyId, customerName, fallback) {
  const customer = await getCustomerRecord(companyId, customerName);
  return normalizeEmail(customer && customer.email) || normalizeEmail(fallback);
}

// Invoice recipient: the customer record wins; the chain root call's
// captured email is the fallback for customers without a record.
async function invoiceRecipient(rootCall) {
  return customerEmailOnFile(rootCall.company_id, rootCall.customer_name, rootCall.customer_email);
}

async function recordInvoiceEmail(rootCall, recipient) {
  const sentAt = new Date();
  await db.q(
    'UPDATE calls SET invoice_emailed_at = $1, invoice_email_recipient = $2 WHERE id = $3 AND company_id = $4',
    [sentAt, recipient, rootCall.id, rootCall.company_id]
  );
  rootCall.invoice_emailed_at = sentAt;
  rootCall.invoice_email_recipient = recipient;
  return sentAt;
}

async function deliverInvoiceEmail({ company, result }) {
  const root = result.root;
  const recipient = await invoiceRecipient(root);
  if (!recipient) return { sent: false, reason: 'missing-recipient', recipient: null };
  if (!mailer.configured()) return { sent: false, reason: 'not-configured', recipient };
  await payments.ensurePayToken(root);
  const owner = await db.one(
    "SELECT * FROM users WHERE company_id = $1 AND role = 'owner' ORDER BY id LIMIT 1",
    [root.company_id]
  );
  await mailer.sendInvoiceEmail({
    to: recipient,
    ownerEmail: owner ? owner.email : null,
    company,
    rootCall: root,
    inv: result.inv,
    settings: result.settings,
    payUrl: payments.payUrl(root),
  });
  await recordInvoiceEmail(root, recipient);
  return { sent: true, reason: null, recipient };
}

// Fire-and-forget in spirit (but awaited so tests and serverless-style
// shutdowns behave): auto-send runs only at the transition into
// invoice-ready, never blocks report completion, and the emailed stamp is
// the guard against repeat auto-sends if that transition is replayed.
async function autoEmailInvoice(call) {
  try {
    if (!mailer.configured()) return false;
    const { calls } = await chainCalls(call);
    const leaf = calls[calls.length - 1];
    if (!leaf || leaf.id !== call.id) return false;
    const result = await invoiceFor(call);
    if (!result || result.root.invoice_emailed_at) return false;
    const delivery = await deliverInvoiceEmail({ company: await db.one('SELECT * FROM companies WHERE id = $1', [call.company_id]), result });
    return delivery.sent;
  } catch (e) {
    console.error('[mailer] automatic invoice email failed:', e.message);
    return false;
  }
}

// ---------------------------------------------------------------------------
// Public routes
// ---------------------------------------------------------------------------
app.get('/healthz', (req, res) => res.json({ ok: true, billing: billing.TEST_MODE ? 'test' : 'stripe' }));

app.get('/', (req, res) => {
  if (req.user) return res.redirect(req.user.role === 'platform' ? '/platform' : '/app');
  res.send(views.landingPage(flashFrom(req)));
});

app.get('/login', (req, res) => {
  if (req.user) return res.redirect(req.user.role === 'platform' ? '/platform' : '/app');
  res.send(views.loginPage(flashFrom(req)));
});

app.post('/login', async (req, res) => {
  const email = String(req.body.email || '').trim().toLowerCase();
  const user = await db.one('SELECT * FROM users WHERE email = $1', [email]);
  if (!user || !user.active) return back(res, '/login', 'err', 'No active account with that email.');
  const ok = await auth.verifyPassword(req.body.password || '', user.password_hash);
  if (!ok) return back(res, '/login', 'err', 'Incorrect password.');
  const token = await auth.createSession(user.id);
  res.setHeader('Set-Cookie', auth.sessionCookie(token));
  res.redirect(user.role === 'platform' ? '/platform' : '/app');
});

app.get('/signup', (req, res) => res.send(views.signupPage(flashFrom(req))));

app.post('/signup', async (req, res) => {
  const companyName = String(req.body.company_name || '').trim();
  const ownerName = String(req.body.owner_name || '').trim();
  const email = String(req.body.email || '').trim().toLowerCase();
  const password = String(req.body.password || '');
  if (!companyName || !ownerName || !email || password.length < 8) {
    return back(res, '/signup', 'err', 'Fill in every field; password must be at least 8 characters.');
  }
  const existing = await db.one('SELECT id FROM users WHERE email = $1', [email]);
  if (existing) return back(res, '/signup', 'err', 'That email already has an account — log in instead.');
  const hash = await auth.hashPassword(password);
  const company = await db.one('INSERT INTO companies (name) VALUES ($1) RETURNING *', [companyName]);
  const user = await db.one(
    'INSERT INTO users (company_id, name, email, password_hash, role) VALUES ($1,$2,$3,$4,$5) RETURNING *',
    [company.id, ownerName, email, hash, 'owner']
  );
  const trialEnd = new Date(Date.now() + 7 * 86400000);
  await db.q('INSERT INTO subscriptions (company_id, status, trial_end) VALUES ($1,$2,$3)', [company.id, 'trialing', trialEnd]);
  await db.q('INSERT INTO company_settings (company_id) VALUES ($1)', [company.id]);
  await db.billingEvent(company.id, 'trial_started', '7-day free trial started at signup.');
  const token = await auth.createSession(user.id);
  res.setHeader('Set-Cookie', auth.sessionCookie(token));
  res.redirect('/app?msg=' + encodeURIComponent('Welcome! Your 7-day free trial has started.'));
});

app.post('/logout', async (req, res) => {
  await auth.destroySession(req.sessionToken);
  res.setHeader('Set-Cookie', 'sid=; Path=/; HttpOnly; Max-Age=0');
  res.redirect('/');
});

// ---------------------------------------------------------------------------
// App routes (company users)
// ---------------------------------------------------------------------------
app.use('/app', auth.requireAuth, companyContext);

app.get('/app', async (req, res) => {
  const cid = req.companyId;
  const bucket = await db.many("SELECT * FROM calls WHERE company_id = $1 AND status = 'bucket' ORDER BY created_at", [cid]);
  const scheduled = await db.many(
    "SELECT * FROM calls WHERE company_id = $1 AND status IN ('scheduled','traveling','on_job') ORDER BY scheduled_date NULLS LAST, id", [cid]);
  const byDay = {};
  for (const c of scheduled) {
    const key = c.scheduled_date ? isoDate(c.scheduled_date) : 'Unscheduled';
    (byDay[key] = byDay[key] || []).push(c);
  }
  const todayGas = await db.many('SELECT * FROM gas_purchases WHERE company_id = $1 AND date = CURRENT_DATE ORDER BY id', [cid]);
  const todayMaint = await db.many('SELECT * FROM maintenance_receipts WHERE company_id = $1 AND date = CURRENT_DATE ORDER BY id', [cid]);
  res.send(views.schedulePage({ user: req.user, sub: req.sub, company: req.company, flash: flashFrom(req), bucket, byDay, todayGas, todayMaint }));
});

// --- Calls: intake / edit ----------------------------------------------------
app.get('/app/calls/new', async (req, res) => {
  let prefill = null;
  if (req.query.customer) {
    const customerName = String(req.query.customer);
    const customer = await getCustomerRecord(req.companyId, customerName);
    prefill = await db.one(
      'SELECT * FROM calls WHERE company_id = $1 AND customer_name = $2 ORDER BY id DESC LIMIT 1',
      [req.companyId, customerName]
    );
    if (customer && customer.email) {
      prefill = { ...(prefill || { customer_name: customerName }), customer_email: customer.email };
    } else if (!prefill && customer) {
      prefill = { customer_name: customerName };
    }
  }
  res.send(views.callFormPage({ user: req.user, sub: req.sub, company: req.company, flash: flashFrom(req), call: null, prefill }));
});

app.post('/app/calls', async (req, res) => {
  const b = req.body;
  const scheduled = b.scheduled_date ? 'scheduled' : 'bucket';
  const customerEmail = normalizeEmail(b.customer_email);
  const call = await db.one(
    `INSERT INTO calls (company_id, customer_name, address, phone, customer_email, poc_name, poc_phone, description, status, scheduled_date, scheduled_time, created_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) RETURNING *`,
    [req.companyId, b.customer_name, b.address || null, b.phone || null, customerEmail, b.poc_name || null, b.poc_phone || null,
     b.description || null, scheduled, b.scheduled_date || null, b.scheduled_time || null, req.user.id]
  );
  await db.q('UPDATE calls SET root_call_id = id WHERE id = $1', [call.id]);
  await syncCustomerEmail(req.companyId, call.customer_name, customerEmail);
  res.redirect('/app?msg=' + encodeURIComponent('Call added to the ' + (scheduled === 'scheduled' ? 'schedule.' : 'bucket.')));
});

async function loadCall(req, res, next) {
  const call = await db.one('SELECT * FROM calls WHERE id = $1 AND company_id = $2', [req.params.id, req.companyId]);
  if (!call) return res.status(404).send('Call not found.');
  req.call = call;
  next();
}

app.get('/app/calls/:id/edit', loadCall, async (req, res) => {
  const customerEmail = await customerEmailOnFile(req.companyId, req.call.customer_name, req.call.customer_email);
  const call = { ...req.call, customer_email: customerEmail };
  res.send(views.callFormPage({ user: req.user, sub: req.sub, company: req.company, flash: flashFrom(req), call, prefill: null }));
});

app.post('/app/calls/:id/edit', loadCall, async (req, res) => {
  const b = req.body;
  const customerEmail = normalizeEmail(b.customer_email);
  let status = req.call.status;
  let date = b.scheduled_date || null;
  let time = b.scheduled_time || null;
  if (b.unschedule) { status = 'bucket'; date = null; time = null; }
  else if (date && status === 'bucket') status = 'scheduled';
  await db.q(
    `UPDATE calls SET customer_name=$1, address=$2, phone=$3, customer_email=$4, poc_name=$5, poc_phone=$6, description=$7,
       status=$8, scheduled_date=$9, scheduled_time=$10 WHERE id=$11 AND company_id=$12`,
    [b.customer_name, b.address || null, b.phone || null, customerEmail, b.poc_name || null, b.poc_phone || null,
     b.description || null, status, date, time, req.call.id, req.companyId]
  );
  await syncCustomerEmail(req.companyId, b.customer_name, customerEmail);
  res.redirect('/app?msg=' + encodeURIComponent('Call saved.'));
});

app.post('/app/calls/:id/delete', loadCall, async (req, res) => {
  await db.q('DELETE FROM calls WHERE id = $1 AND company_id = $2', [req.call.id, req.companyId]);
  res.redirect('/app?msg=' + encodeURIComponent('Call deleted.'));
});

app.post('/app/calls/:id/back-to-bucket', loadCall, async (req, res) => {
  await db.q("UPDATE calls SET status='bucket', scheduled_date=NULL, scheduled_time=NULL WHERE id=$1 AND company_id=$2", [req.call.id, req.companyId]);
  res.redirect('/app/completed?msg=' + encodeURIComponent('Call moved back to the bucket.'));
});

// --- Job run flow ---------------------------------------------------------------
app.get('/app/calls/:id', loadCall, async (req, res) => {
  const cid = req.companyId;
  const { calls } = await chainCalls(req.call);
  const totals = await chainTotals(cid, calls.map((c) => c.id));
  const report = await db.one('SELECT * FROM job_reports WHERE call_id = $1', [req.call.id]);
  const openPunch = await db.one('SELECT * FROM punches WHERE company_id = $1 AND call_id = $2 AND clock_out IS NULL ORDER BY id DESC LIMIT 1', [cid, req.call.id]);
  const openTrip = await db.one('SELECT * FROM trips WHERE company_id = $1 AND call_id = $2 AND ended_at IS NULL ORDER BY id DESC LIMIT 1', [cid, req.call.id]);
  const inv = req.call.status === 'completed' ? await invoiceFor(req.call) : null;
  res.send(views.jobPage({
    user: req.user, sub: req.sub, company: req.company, flash: flashFrom(req), call: req.call,
    report, openPunch, openTrip, chainHours: totals.hours, chainMiles: totals.miles, invoiceReady: !!inv,
  }));
});

app.post('/app/calls/:id/start-travel', loadCall, async (req, res) => {
  await db.q("UPDATE calls SET status='traveling' WHERE id=$1 AND company_id=$2", [req.call.id, req.companyId]);
  await db.q("INSERT INTO trips (company_id, call_id, user_id, kind) VALUES ($1,$2,$3,'travel')", [req.companyId, req.call.id, req.user.id]);
  res.redirect(`/app/calls/${req.call.id}`);
});

app.post('/app/calls/:id/cancel-travel', loadCall, async (req, res) => {
  await db.q('DELETE FROM trips WHERE company_id=$1 AND call_id=$2 AND ended_at IS NULL', [req.companyId, req.call.id]);
  const status = req.call.scheduled_date ? 'scheduled' : 'bucket';
  await db.q('UPDATE calls SET status=$1 WHERE id=$2 AND company_id=$3', [status, req.call.id, req.companyId]);
  res.redirect('/app?msg=' + encodeURIComponent('Travel leg canceled.'));
});

app.post('/app/calls/:id/start-job', loadCall, async (req, res) => {
  const miles = parseFloat(req.body.miles || req.body.miles_manual || '0') || 0;
  await db.q('UPDATE trips SET miles=$1, ended_at=now() WHERE company_id=$2 AND call_id=$3 AND ended_at IS NULL',
    [miles, req.companyId, req.call.id]);
  await db.q("UPDATE calls SET status='on_job' WHERE id=$1 AND company_id=$2", [req.call.id, req.companyId]);
  const label = `${req.call.customer_name} — ${req.call.description || 'Job'}`;
  await db.q('INSERT INTO punches (company_id, call_id, user_id, job_label) VALUES ($1,$2,$3,$4)',
    [req.companyId, req.call.id, req.user.id, label]);
  res.redirect(`/app/calls/${req.call.id}/report`);
});

app.post('/app/calls/:id/end-call', loadCall, async (req, res) => {
  const report = await db.one('SELECT * FROM job_reports WHERE call_id = $1', [req.call.id]);
  if (!report || !report.complete) {
    return back(res, `/app/calls/${req.call.id}`, 'err', 'Mark the job complete in the report before ending the call.');
  }
  await db.q('UPDATE punches SET clock_out=now() WHERE company_id=$1 AND call_id=$2 AND clock_out IS NULL', [req.companyId, req.call.id]);
  await db.q("UPDATE calls SET status='completed', completed_at=now() WHERE id=$1 AND company_id=$2", [req.call.id, req.companyId]);
  res.redirect('/app?msg=' + encodeURIComponent('Call ended — nice work.'));
});

// --- Job report -------------------------------------------------------------------
app.get('/app/calls/:id/report', loadCall, async (req, res) => {
  const { calls } = await chainCalls(req.call);
  const totals = await chainTotals(req.companyId, calls.map((c) => c.id));
  const report = await db.one('SELECT * FROM job_reports WHERE call_id = $1', [req.call.id]);
  res.send(views.reportPage({
    user: req.user, sub: req.sub, company: req.company, flash: flashFrom(req), call: req.call, report,
    chainHours: totals.hours, chainMiles: totals.miles, print: req.query.print === '1',
  }));
});

app.post('/app/calls/:id/report', loadCall, async (req, res) => {
  const b = req.body;
  const followUp = b.follow_up === '1';
  const complete = b.complete === '1';
  if (followUp && !b.follow_up_date) {
    return back(res, `/app/calls/${req.call.id}/report`, 'err', 'Follow-up is checked — a follow-up date is required.');
  }
  const qtys = [].concat(b.part_qty || []);
  const descs = [].concat(b.part_desc || []);
  const costs = [].concat(b.part_cost || []);
  const parts = [];
  for (let i = 0; i < descs.length; i++) {
    if (!descs[i] && !costs[i]) continue;
    parts.push({ qty: Number(qtys[i] || 0), description: descs[i] || '', costCents: dollarsToCents(costs[i]) });
  }
  let photos = [];
  try { photos = JSON.parse(b.photos_json || '[]'); } catch (e) { photos = []; }

  const existing = await db.one('SELECT * FROM job_reports WHERE call_id = $1', [req.call.id]);
  const wasInvoiceReady = !!(existing && existing.complete && !existing.follow_up);
  const values = [req.call.id, req.companyId, b.asset_name || null, b.asset_make || null, b.asset_model || null,
    b.asset_serial || null, b.location_on_site || null, b.work_performed || null, JSON.stringify(parts),
    b.notes || null, JSON.stringify(photos), followUp, b.follow_up_date || null, b.follow_up_description || null, complete];
  if (existing) {
    await db.q(`UPDATE job_reports SET asset_name=$3, asset_make=$4, asset_model=$5, asset_serial=$6,
      location_on_site=$7, work_performed=$8, parts=$9, notes=$10, photos=$11, follow_up=$12,
      follow_up_date=$13, follow_up_description=$14, complete=$15, updated_at=now()
      WHERE call_id=$1 AND company_id=$2`, values);
  } else {
    await db.q(`INSERT INTO job_reports (call_id, company_id, asset_name, asset_make, asset_model, asset_serial,
      location_on_site, work_performed, parts, notes, photos, follow_up, follow_up_date, follow_up_description, complete)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)`, values);
  }

  // Follow-up: create the chained call on the schedule (once).
  if (followUp && b.follow_up_date) {
    const child = await db.one('SELECT id FROM calls WHERE parent_call_id = $1', [req.call.id]);
    if (!child) {
      const rootId = req.call.root_call_id || req.call.id;
      const followUpEmail = await customerEmailOnFile(req.companyId, req.call.customer_name, req.call.customer_email);
      const nc = await db.one(
        `INSERT INTO calls (company_id, customer_name, address, phone, customer_email, poc_name, poc_phone, description,
           status, scheduled_date, root_call_id, parent_call_id, created_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'scheduled',$9,$10,$11,$12) RETURNING *`,
        [req.companyId, req.call.customer_name, req.call.address, req.call.phone, followUpEmail, req.call.poc_name,
         req.call.poc_phone, b.follow_up_description || req.call.description, b.follow_up_date, rootId, req.call.id, req.user.id]
      );
      await syncCustomerEmail(req.companyId, nc.customer_name, nc.customer_email);
      void nc;
    }
  }
  // Invoice generation point in this derived-invoice model: the final
  // report has just transitioned to complete with no follow-up pending.
  // Auto-email is best-effort and must never block saving/completing a job.
  if (complete && !followUp && !wasInvoiceReady) {
    await autoEmailInvoice(req.call);
  }
  res.redirect(`/app/calls/${req.call.id}/report?msg=` + encodeURIComponent(complete ? 'Report saved — job marked complete.' : 'Report saved.'));
});

// --- Invoice ----------------------------------------------------------------------
app.get('/app/calls/:id/invoice', loadCall, async (req, res) => {
  const result = await invoiceFor(req.call);
  if (!result) return back(res, '/app/completed', 'err', 'No invoice yet — invoices generate when the final call in the chain is marked complete with no follow-up pending.');
  await payments.ensurePayToken(result.root);
  const recipientEmail = await invoiceRecipient(result.root);
  res.send(views.invoicePage({
    user: req.user, sub: req.sub, company: req.company, settings: result.settings,
    rootCall: result.root, inv: result.inv, print: req.query.print === '1',
    payUrl: payments.payUrl(result.root),
    recipientEmail,
    canManage: ['owner', 'admin'].includes(req.user.role),
    resendConfigured: mailer.configured(),
  }));
});

// Manual payment recording (cash / check / Venmo / PayPal / other) — the
// payment state lives on the chain's root call.
app.post('/app/calls/:id/mark-paid', auth.requireRole('owner', 'admin'), loadCall, async (req, res) => {
  const result = await invoiceFor(req.call);
  if (!result) return back(res, '/app/completed', 'err', 'No invoice yet for this call chain.');
  const methods = ['Cash', 'Check', 'Venmo', 'PayPal', 'Other'];
  const method = methods.includes(req.body.method) ? req.body.method : 'Other';
  const dateStr = /^\d{4}-\d{2}-\d{2}$/.test(String(req.body.paid_date || '')) ? String(req.body.paid_date) : isoDate(new Date());
  const changed = await payments.markInvoicePaid(result.root.id, {
    method,
    reference: String(req.body.reference || '').trim() || null,
    paidAt: new Date(`${dateStr}T12:00:00Z`),
  });
  res.redirect(`/app/calls/${req.call.id}/invoice?msg=` + encodeURIComponent(
    changed ? `Invoice marked as paid (${method}).` : 'Invoice was already marked paid.'));
});

// Email the invoice (with its pay link) to the customer. The recipient is
// resolved customers-table-first, then the ROOT call's customer_email. An
// address supplied by this form is saved to both places before sending.
app.post('/app/calls/:id/email-invoice', auth.requireRole('owner', 'admin'), loadCall, async (req, res) => {
  const invoiceUrl = `/app/calls/${req.call.id}/invoice`;
  const result = await invoiceFor(req.call);
  if (!result) return back(res, '/app/completed', 'err', 'No invoice yet for this call chain.');
  const root = result.root;
  const provided = normalizeEmail(req.body.customer_email);
  if (provided) {
    if (!isEmail(provided)) return back(res, invoiceUrl, 'err', 'That email address does not look valid.');
    await db.q('UPDATE calls SET customer_email = $1 WHERE id = $2 AND company_id = $3', [provided, root.id, req.companyId]);
    root.customer_email = provided;
    await syncCustomerEmail(req.companyId, root.customer_name, provided);
  }
  const recipient = await invoiceRecipient(root);
  if (!recipient) {
    return back(res, invoiceUrl, 'err', 'Add the customer\'s email address first, then send.');
  }
  if (!mailer.configured()) {
    return back(res, invoiceUrl, 'err', 'Email isn\'t configured yet — the server needs a RESEND_API_KEY before invoices can be emailed. You can still copy the pay link below and send it yourself.');
  }
  try {
    const delivery = await deliverInvoiceEmail({ company: req.company, result });
    if (!delivery.sent) throw new Error('Invoice email was not sent.');
  } catch (e) {
    console.error('[mailer] invoice email failed:', e.message);
    return back(res, invoiceUrl, 'err', 'Invoice email failed to send — ' + e.message);
  }
  res.redirect(invoiceUrl + '?msg=' + encodeURIComponent(`Invoice emailed to ${recipient}.`));
});

// --- Public invoice pay page ---------------------------------------------------
// No login: the unguessable pay_token on the chain's root call is the key.
async function loadPayInvoice(token) {
  const root = await db.one('SELECT * FROM calls WHERE pay_token = $1', [token]);
  if (!root) return null;
  const result = await invoiceFor(root);
  if (!result) return null;
  const company = await db.one('SELECT * FROM companies WHERE id = $1', [root.company_id]);
  if (!company) return null;
  return { root: result.root, company, settings: result.settings, inv: result.inv };
}

app.get('/pay/:token', async (req, res) => {
  const data = await loadPayInvoice(req.params.token);
  if (!data) return res.status(404).send('Invoice not found.');
  const { root, company, settings, inv } = data;
  // Success-return fallback: if Stripe says this session was paid, record it
  // even if the Connect webhook destination has not delivered yet.
  if (req.query.paid === '1' && req.query.session_id && root.payment_status !== 'paid'
      && !billing.TEST_MODE && settings.stripe_account_id && !payments.isSimulatedAccount(settings.stripe_account_id)) {
    try {
      const marked = await payments.verifyCheckoutSession({ settings, rootCall: root, sessionId: String(req.query.session_id) });
      if (marked) root.payment_status = 'paid';
    } catch (e) {
      console.error('[pay] session verify failed:', e.message);
    }
  }
  let state = 'unavailable';
  if (root.payment_status === 'paid') state = 'paid';
  else if (settings.stripe_account_id && settings.stripe_charges_enabled) state = 'pay';
  res.send(views.payPage({
    company, rootCall: root, inv, settings, state,
    testMode: billing.TEST_MODE, justPaid: req.query.paid === '1', flash: flashFrom(req),
  }));
});

app.post('/pay/:token/checkout', async (req, res) => {
  const data = await loadPayInvoice(req.params.token);
  if (!data) return res.status(404).send('Invoice not found.');
  const { root, company, settings, inv } = data;
  if (root.payment_status === 'paid') return res.redirect(`/pay/${req.params.token}`); // never charge twice
  if (billing.TEST_MODE) return res.redirect(`/pay/${req.params.token}?err=` + encodeURIComponent('TEST MODE: card checkout is simulated — use the simulate button on the pay page.'));
  if (!settings.stripe_account_id || !settings.stripe_charges_enabled) {
    return res.redirect(`/pay/${req.params.token}?err=` + encodeURIComponent('Online payment is not available for this invoice — please contact the company.'));
  }
  try {
    const session = await payments.createInvoiceCheckout({ company, settings, rootCall: root, inv });
    res.redirect(session.url);
  } catch (e) {
    console.error('[pay] checkout failed:', e.message);
    res.redirect(`/pay/${req.params.token}?err=` + encodeURIComponent('Could not start the card payment — please contact the company.'));
  }
});

// TEST MODE only: simulate a successful card payment on the pay page.
app.post('/pay/:token/simulate', async (req, res) => {
  if (!billing.TEST_MODE) return res.status(403).send('Live mode.');
  const data = await loadPayInvoice(req.params.token);
  if (!data) return res.status(404).send('Invoice not found.');
  if (data.root.payment_status !== 'paid') {
    await payments.markInvoicePaid(data.root.id, {
      method: 'card', reference: 'TEST MODE simulated payment', paidAt: new Date(),
    });
  }
  res.redirect(`/pay/${req.params.token}?paid=1`);
});

// --- Completed / Customers ---------------------------------------------------
app.get('/app/completed', async (req, res) => {
  const rows = await db.many(
    "SELECT * FROM calls WHERE company_id = $1 AND status = 'completed' ORDER BY completed_at DESC NULLS LAST, id DESC", [req.companyId]);
  const out = [];
  for (const call of rows) {
    const inv = await invoiceFor(call);
    out.push({
      call,
      hasInvoice: !!inv,
      paid: !!inv && inv.root.payment_status === 'paid',
      payMethod: inv ? inv.root.payment_method : null,
    });
  }
  res.send(views.completedPage({ user: req.user, sub: req.sub, company: req.company, flash: flashFrom(req), rows: out }));
});

app.get('/app/customers', async (req, res) => {
  const qstr = String(req.query.q || '').trim();
  const customers = await db.many(
    `SELECT c.customer_name, COUNT(*)::int AS call_count,
            (ARRAY_AGG(c.address ORDER BY c.id DESC))[1] AS address,
            (ARRAY_AGG(c.phone ORDER BY c.id DESC))[1] AS phone,
            MAX(cust.email) AS email
       FROM calls c
       LEFT JOIN customers cust
         ON cust.company_id = c.company_id AND cust.customer_name = c.customer_name
      WHERE c.company_id = $1
        AND ($2 = '' OR c.customer_name ILIKE $3 OR c.address ILIKE $3 OR c.phone ILIKE $3 OR cust.email ILIKE $3)
      GROUP BY c.customer_name ORDER BY c.customer_name`,
    [req.companyId, qstr, '%' + qstr + '%']
  );
  res.send(views.customersPage({
    user: req.user, sub: req.sub, company: req.company, flash: flashFrom(req), customers, q: qstr,
    canEditCustomerEmail: ['owner', 'admin'].includes(req.user.role),
  }));
});

app.post('/app/customers/:name/email', auth.requireRole('owner', 'admin'), async (req, res) => {
  const name = req.params.name;
  const known = await db.one(
    `SELECT 1 AS found FROM calls WHERE company_id = $1 AND customer_name = $2
     UNION ALL
     SELECT 1 AS found FROM customers WHERE company_id = $1 AND customer_name = $2
     LIMIT 1`,
    [req.companyId, name]
  );
  const detailUrl = `/app/customers/${encodeURIComponent(name)}`;
  if (!known) return res.status(404).send('Customer not found.');
  const email = normalizeEmail(req.body.email);
  if (email && !isEmail(email)) {
    return back(res, req.body.from === 'list' ? '/app/customers' : detailUrl, 'err', 'That email address does not look valid.');
  }
  await db.q(
    `INSERT INTO customers (company_id, customer_name, email)
     VALUES ($1, $2, $3)
     ON CONFLICT (company_id, customer_name)
     DO UPDATE SET email = EXCLUDED.email, updated_at = now()`,
    [req.companyId, name, email]
  );
  const target = req.body.from === 'list' ? '/app/customers' : detailUrl;
  res.redirect(target + '?msg=' + encodeURIComponent(email ? `Customer email saved: ${email}.` : 'Customer email cleared.'));
});

app.get('/app/customers/:name', async (req, res) => {
  const name = req.params.name;
  const calls = await db.many('SELECT * FROM calls WHERE company_id = $1 AND customer_name = $2 ORDER BY id DESC', [req.companyId, name]);
  const customer = await getCustomerRecord(req.companyId, name);
  if (!calls.length && !customer) return res.status(404).send('Customer not found.');
  res.send(views.customerDetailPage({
    user: req.user, sub: req.sub, company: req.company, flash: flashFrom(req), name, calls, customer,
    canEditCustomerEmail: ['owner', 'admin'].includes(req.user.role),
  }));
});

// --- Log & Report ---------------------------------------------------------------
function payPeriods(settings, count = 6) {
  const anchor = new Date(settings.pay_anchor);
  const cycle = Number(settings.pay_cycle_days) || 14;
  const now = new Date();
  const periodsBack = Math.max(0, Math.floor((now - anchor) / (cycle * 86400000)));
  const out = [];
  for (let i = 0; i < count; i++) {
    const idx = periodsBack - i;
    if (idx < 0) break;
    const start = new Date(anchor.getTime() + idx * cycle * 86400000);
    const end = new Date(start.getTime() + cycle * 86400000);
    out.push({ start, end, label: `${isoDate(start)} → ${isoDate(new Date(end.getTime() - 86400000))}` });
  }
  return out;
}

app.get('/app/log', async (req, res) => {
  const cid = req.companyId;
  const s = req.settings;
  const periods = payPeriods(s);
  const selected = Math.min(Math.max(parseInt(req.query.period || '0', 10) || 0, 0), periods.length - 1);
  const period = periods[selected] || { start: new Date(0), end: new Date(), label: 'All time' };

  const punches = await db.many('SELECT * FROM punches WHERE company_id=$1 AND clock_in >= $2 AND clock_in < $3 ORDER BY clock_in', [cid, period.start, period.end]);
  const trips = await db.many('SELECT * FROM trips WHERE company_id=$1 AND started_at >= $2 AND started_at < $3 ORDER BY started_at', [cid, period.start, period.end]);
  const gas = await db.many('SELECT * FROM gas_purchases WHERE company_id=$1 AND date >= $2::date AND date < $3::date ORDER BY date', [cid, isoDate(period.start), isoDate(period.end)]);
  const maint = await db.many('SELECT * FROM maintenance_receipts WHERE company_id=$1 AND date >= $2::date AND date < $3::date ORDER BY date', [cid, isoDate(period.start), isoDate(period.end)]);

  async function rangeTotals(start, end) {
    const p = await db.many('SELECT * FROM punches WHERE company_id=$1 AND clock_in >= $2 AND clock_in < $3', [cid, start, end]);
    const t = await db.many('SELECT COALESCE(SUM(miles),0) AS m FROM trips WHERE company_id=$1 AND started_at >= $2 AND started_at < $3', [cid, start, end]);
    return { hours: p.reduce((sum, x) => sum + hoursBetween(x.clock_in, x.clock_out), 0), miles: Number(t[0].m || 0) };
  }
  const monthStart = new Date(period.start.getFullYear(), period.start.getMonth(), 1);
  const monthEnd = new Date(period.start.getFullYear(), period.start.getMonth() + 1, 1);
  const month = await rangeTotals(monthStart, monthEnd);
  const quarter = await rangeTotals(new Date(s.quarter_start), new Date(new Date(s.quarter_end).getTime() + 86400000));

  const byJobMap = {};
  for (const p of punches) {
    const key = p.job_label || 'No job';
    byJobMap[key] = byJobMap[key] || { job: key, hours: 0, miles: 0 };
    byJobMap[key].hours += hoursBetween(p.clock_in, p.clock_out);
  }
  const callLabels = {};
  const allCalls = await db.many('SELECT id, customer_name, description FROM calls WHERE company_id=$1', [cid]);
  for (const c of allCalls) callLabels[c.id] = `${c.customer_name} — ${c.description || 'Job'}`;
  for (const t of trips) {
    const key = t.call_id ? (callLabels[t.call_id] || 'Job') : 'Manual miles';
    byJobMap[key] = byJobMap[key] || { job: key, hours: 0, miles: 0 };
    byJobMap[key].miles += Number(t.miles || 0);
  }

  const totals = {
    hours: punches.reduce((sum, p) => sum + hoursBetween(p.clock_in, p.clock_out), 0),
    miles: trips.reduce((sum, t) => sum + Number(t.miles || 0), 0),
    gasCents: gas.reduce((sum, g) => sum + g.amount_cents, 0),
    maintCents: maint.reduce((sum, m) => sum + m.amount_cents, 0),
    byJob: Object.values(byJobMap),
    monthHours: month.hours, monthMiles: month.miles,
    quarterHours: quarter.hours, quarterMiles: quarter.miles,
  };
  res.send(views.logPage({
    user: req.user, sub: req.sub, company: req.company, flash: flashFrom(req),
    punches, trips, gas, maint, totals, periodLabel: period.label, periods, selectedPeriod: selected,
  }));
});

app.post('/app/punches', async (req, res) => {
  const b = req.body;
  const date = b.date || isoDate(new Date());
  let clockIn, clockOut;
  if (b.pto) {
    clockIn = new Date(`${date}T08:30:00`);
    clockOut = new Date(`${date}T16:30:00`);
  } else {
    clockIn = new Date(`${date}T${b.start || '08:30'}:00`);
    clockOut = new Date(`${date}T${b.end || '16:30'}:00`);
  }
  const label = (b.job_label || 'Shift') + (b.pto ? ' (PTO)' : '');
  await db.q('INSERT INTO punches (company_id, user_id, job_label, clock_in, clock_out) VALUES ($1,$2,$3,$4,$5)',
    [req.companyId, req.user.id, label, clockIn, clockOut]);
  res.redirect('/app/log?msg=' + encodeURIComponent('Time added.'));
});

app.post('/app/punches/:id/delete', async (req, res) => {
  await db.q('DELETE FROM punches WHERE id=$1 AND company_id=$2', [req.params.id, req.companyId]);
  res.redirect('/app/log?msg=' + encodeURIComponent('Shift deleted.'));
});

app.post('/app/trips', async (req, res) => {
  const miles = parseFloat(req.body.miles || '0') || 0;
  const when = req.body.date ? new Date(`${req.body.date}T12:00:00`) : new Date();
  await db.q("INSERT INTO trips (company_id, user_id, kind, miles, note, started_at, ended_at) VALUES ($1,$2,'manual',$3,$4,$5,$5)",
    [req.companyId, req.user.id, miles, req.body.note || null, when]);
  res.redirect('/app/log?msg=' + encodeURIComponent('Miles added.'));
});

// --- Gas & maintenance ----------------------------------------------------------
app.post('/app/gas', async (req, res) => {
  const b = req.body;
  await db.q('INSERT INTO gas_purchases (company_id, user_id, date, amount_cents, gallons, note, receipt_photo) VALUES ($1,$2,$3,$4,$5,$6,$7)',
    [req.companyId, req.user.id, b.date || isoDate(new Date()), dollarsToCents(b.amount), parseFloat(b.gallons) || null, b.note || null, b.receipt_photo || null]);
  res.redirect('/app?msg=' + encodeURIComponent('Gas saved.'));
});
app.post('/app/gas/:id/delete', async (req, res) => {
  await db.q('DELETE FROM gas_purchases WHERE id=$1 AND company_id=$2', [req.params.id, req.companyId]);
  res.redirect('/app?msg=' + encodeURIComponent('Gas entry deleted.'));
});
app.post('/app/maintenance', async (req, res) => {
  const b = req.body;
  await db.q('INSERT INTO maintenance_receipts (company_id, user_id, date, amount_cents, work_done, shop, note, receipt_photo) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)',
    [req.companyId, req.user.id, b.date || isoDate(new Date()), dollarsToCents(b.amount), b.work_done || null, b.shop || null, b.note || null, b.receipt_photo || null]);
  res.redirect('/app?msg=' + encodeURIComponent('Maintenance saved.'));
});
app.post('/app/maintenance/:id/delete', async (req, res) => {
  await db.q('DELETE FROM maintenance_receipts WHERE id=$1 AND company_id=$2', [req.params.id, req.companyId]);
  res.redirect('/app?msg=' + encodeURIComponent('Maintenance entry deleted.'));
});

// --- Settings ---------------------------------------------------------------------
app.get('/app/settings', auth.requireRole('owner', 'admin'), (req, res) => {
  res.send(views.settingsPage({ user: req.user, sub: req.sub, company: req.company, flash: flashFrom(req), s: req.settings }));
});
app.post('/app/settings', auth.requireRole('owner', 'admin'), async (req, res) => {
  const b = req.body;
  await db.q(`UPDATE company_settings SET hourly_rate_cents=$2, tax_percent=$3, parts_multiplier=$4,
      reminder_in=$5, reminder_out=$6, pay_anchor=$7, pay_cycle_days=$8, quarter_start=$9, quarter_end=$10
    WHERE company_id=$1`,
    [req.companyId, dollarsToCents(b.hourly_rate), Number(b.tax_percent) || 0, Number(b.parts_multiplier) || 1,
     b.reminder_in || '08:30', b.reminder_out || '16:30', b.pay_anchor, parseInt(b.pay_cycle_days, 10) || 14,
     b.quarter_start, b.quarter_end]);
  res.redirect('/app/settings?msg=' + encodeURIComponent('Settings saved.'));
});

// --- Stripe Connect (owner only): invoice card payments ----------------------
// Creates the company's Express account on first use, then sends the owner
// through Stripe-hosted onboarding. Charges enable asynchronously on
// Stripe's side; the return route re-reads and stores the status.
app.post('/app/settings/connect', auth.requireRole('owner'), async (req, res) => {
  if (billing.TEST_MODE) return back(res, '/app/settings', 'err', 'TEST MODE — use "Simulate Connect setup" instead.');
  try {
    let accountId = req.settings.stripe_account_id;
    if (!accountId || payments.isSimulatedAccount(accountId)) {
      const account = await payments.createExpressAccount(req.company, req.user);
      accountId = account.id;
      await db.q('UPDATE company_settings SET stripe_account_id = $1, stripe_charges_enabled = FALSE WHERE company_id = $2',
        [accountId, req.companyId]);
    }
    const link = await payments.createOnboardingLink(accountId);
    res.redirect(link.url);
  } catch (e) {
    console.error('[connect] onboarding start failed:', e.message);
    back(res, '/app/settings', 'err', 'Could not start Stripe Connect onboarding — check the server Stripe keys and Connect settings.');
  }
});
app.get('/app/settings/connect/return', auth.requireRole('owner'), async (req, res) => {
  let enabled = !!req.settings.stripe_charges_enabled;
  if (!billing.TEST_MODE && req.settings.stripe_account_id && !payments.isSimulatedAccount(req.settings.stripe_account_id)) {
    try {
      const account = await payments.refreshConnectStatus(req.settings);
      enabled = !!account.charges_enabled;
    } catch (e) {
      console.error('[connect] status refresh failed:', e.message);
    }
  }
  back(res, '/app/settings', enabled ? 'msg' : 'err', enabled
    ? 'Stripe Connect is active — customers can now pay invoices by card.'
    : 'Connect setup is not finished yet — card payments turn on once Stripe enables charges for your account.');
});
app.get('/app/settings/connect/refresh', auth.requireRole('owner'), async (req, res) => {
  // Stripe sends the owner here when an onboarding link has expired.
  if (billing.TEST_MODE || !req.settings.stripe_account_id || payments.isSimulatedAccount(req.settings.stripe_account_id)) {
    return res.redirect('/app/settings');
  }
  try {
    const link = await payments.createOnboardingLink(req.settings.stripe_account_id);
    res.redirect(link.url);
  } catch (e) {
    console.error('[connect] onboarding refresh failed:', e.message);
    back(res, '/app/settings', 'err', 'Could not refresh the Stripe onboarding link.');
  }
});
// TEST MODE only: simulate a finished Connect setup locally.
app.post('/app/settings/connect/simulate', auth.requireRole('owner'), async (req, res) => {
  if (!billing.TEST_MODE) return res.status(403).send('Live mode.');
  await db.q('UPDATE company_settings SET stripe_account_id = $1, stripe_charges_enabled = TRUE WHERE company_id = $2',
    ['acct_test_' + req.companyId, req.companyId]);
  res.redirect('/app/settings?msg=' + encodeURIComponent('TEST MODE: Connect simulated — invoice pay links now offer a (simulated) card payment.'));
});

// --- Users --------------------------------------------------------------------------
app.get('/app/users', auth.requireRole('owner', 'admin'), async (req, res) => {
  const users = await db.many('SELECT * FROM users WHERE company_id=$1 ORDER BY id', [req.companyId]);
  res.send(views.usersPage({ user: req.user, sub: req.sub, company: req.company, flash: flashFrom(req), users }));
});
app.post('/app/users', auth.requireRole('owner', 'admin'), async (req, res) => {
  const b = req.body;
  const email = String(b.email || '').trim().toLowerCase();
  const role = ['owner', 'admin', 'tech'].includes(b.role) ? b.role : 'tech';
  if (role === 'owner' && req.user.role !== 'owner') return back(res, '/app/users', 'err', 'Only an owner can add another owner.');
  const existing = await db.one('SELECT id FROM users WHERE email=$1', [email]);
  if (existing) return back(res, '/app/users', 'err', 'That email is already in use.');
  const hash = await auth.hashPassword(b.password || '');
  await db.q('INSERT INTO users (company_id, name, email, password_hash, role) VALUES ($1,$2,$3,$4,$5)',
    [req.companyId, b.name, email, hash, role]);
  res.redirect('/app/users?msg=' + encodeURIComponent('User added.'));
});
async function loadCompanyUser(req, res, next) {
  const u = await db.one('SELECT * FROM users WHERE id=$1 AND company_id=$2', [req.params.id, req.companyId]);
  if (!u) return res.status(404).send('User not found.');
  if (u.role === 'owner' && req.user.role !== 'owner') return res.status(403).send('Only an owner can modify an owner account.');
  req.targetUser = u;
  next();
}
app.post('/app/users/:id/toggle', auth.requireRole('owner', 'admin'), loadCompanyUser, async (req, res) => {
  await db.q('UPDATE users SET active = NOT active WHERE id=$1', [req.targetUser.id]);
  res.redirect('/app/users?msg=' + encodeURIComponent('User updated.'));
});
app.post('/app/users/:id/reset', auth.requireRole('owner', 'admin'), loadCompanyUser, async (req, res) => {
  const pw = String(req.body.password || '');
  if (pw.length < 8) return back(res, '/app/users', 'err', 'Password must be at least 8 characters.');
  const hash = await auth.hashPassword(pw);
  await db.q('UPDATE users SET password_hash=$1 WHERE id=$2', [hash, req.targetUser.id]);
  res.redirect('/app/users?msg=' + encodeURIComponent('Password reset.'));
});

// --- Billing (owner only) --------------------------------------------------------------
app.get('/app/billing', auth.requireRole('owner'), async (req, res) => {
  const events = await db.many('SELECT * FROM billing_events WHERE company_id=$1 ORDER BY id DESC LIMIT 50', [req.companyId]);
  res.send(views.billingPage({
    user: req.user, sub: req.sub, company: req.company, flash: flashFrom(req), events,
    checkoutState: req.query.checkout || null,
  }));
});
app.post('/app/billing/checkout', auth.requireRole('owner'), async (req, res) => {
  if (billing.TEST_MODE) return back(res, '/app/billing', 'err', 'Billing is in TEST MODE — use the test payment form below.');
  try {
    const url = await billing.createCheckoutSession(req.company, req.user);
    res.redirect(url);
  } catch (e) {
    console.error('[billing] checkout failed', e.message);
    back(res, '/app/billing', 'err', 'Could not start Stripe Checkout. Check the Stripe keys and price ID.');
  }
});
app.post('/app/billing/portal', auth.requireRole('owner'), async (req, res) => {
  if (billing.TEST_MODE) return back(res, '/app/billing', 'err', 'Billing is in TEST MODE — there is no Stripe portal yet.');
  const url = await billing.createPortalSession(req.company);
  if (!url) return back(res, '/app/billing', 'err', 'No Stripe customer yet — add a payment method first.');
  res.redirect(url);
});
app.post('/app/billing/test-card', auth.requireRole('owner'), async (req, res) => {
  if (!billing.TEST_MODE) return res.status(403).send('Live mode.');
  const num = String(req.body.card_number || '').replace(/\D/g, '');
  const last4 = num.slice(-4) || '4242';
  const wasLocked = LOCKED_STATUSES.includes(req.sub.status);
  await billing.setStatus(req.companyId, req.sub.status, { payment_brand: 'Visa (test)', payment_last4: last4 });
  await db.billingEvent(req.companyId, 'payment_method_added', `Test card •••• ${last4} saved.`);
  if (wasLocked) {
    await billing.setStatus(req.companyId, 'active', { current_period_end: new Date(Date.now() + 30 * 86400000) });
    await db.billingEvent(req.companyId, 'reactivated', 'Payment method added after trial ended — subscription active.');
  }
  res.redirect('/app/billing?msg=' + encodeURIComponent('Test payment method saved.'));
});
app.post('/app/billing/simulate-fail', auth.requireRole('owner'), async (req, res) => {
  if (!billing.TEST_MODE) return res.status(403).send('Live mode.');
  await billing.setStatus(req.companyId, 'past_due');
  await db.billingEvent(req.companyId, 'payment_failed', 'Simulated failed payment (test mode).');
  res.redirect('/app/billing?msg=' + encodeURIComponent('Simulated: subscription is now past due.'));
});
app.post('/app/billing/simulate-retry', auth.requireRole('owner'), async (req, res) => {
  if (!billing.TEST_MODE) return res.status(403).send('Live mode.');
  if (!req.sub.payment_last4) return back(res, '/app/billing', 'err', 'Add a payment method before retrying.');
  await billing.setStatus(req.companyId, 'active', { current_period_end: new Date(Date.now() + 30 * 86400000) });
  await db.billingEvent(req.companyId, 'payment_retried', 'Simulated successful retry (test mode).');
  res.redirect('/app/billing?msg=' + encodeURIComponent('Simulated: payment succeeded — subscription active.'));
});

// --- Platform admin ------------------------------------------------------------------------
function requirePlatform(req, res, next) {
  if (!req.user) return res.redirect('/login');
  if (req.user.role !== 'platform') return res.status(403).send('Platform admin only. Sign in with the platform admin account to see every company.');
  next();
}
app.get('/platform', requirePlatform, async (req, res) => {
  const companies = await db.many(
    `SELECT c.*, s.status AS sub_status, s.trial_end,
            (SELECT COUNT(*)::int FROM users u WHERE u.company_id = c.id) AS user_count
       FROM companies c LEFT JOIN subscriptions s ON s.company_id = c.id ORDER BY c.id`);
  const totals = {
    companies: companies.length,
    trialing: companies.filter((c) => c.sub_status === 'trialing').length,
    active: companies.filter((c) => c.sub_status === 'active').length,
  };
  const demo = await db.one("SELECT id FROM companies WHERE name = 'Demo Doors LLC' LIMIT 1");
  res.send(views.platformPage({ user: req.user, flash: flashFrom(req), companies, totals, demoId: demo ? demo.id : null }));
});
app.post('/platform/companies/:id/extend-trial', requirePlatform, async (req, res) => {
  const sub = await db.one('SELECT * FROM subscriptions WHERE company_id=$1', [req.params.id]);
  if (sub) {
    const base = new Date(sub.trial_end) > new Date() ? new Date(sub.trial_end) : new Date();
    const newEnd = new Date(base.getTime() + 7 * 86400000);
    const status = sub.status === 'trial_ended' ? 'trialing' : sub.status;
    await billing.setStatus(Number(req.params.id), status, { trial_end: newEnd });
    await db.billingEvent(Number(req.params.id), 'trial_extended', 'Platform admin extended the trial by 7 days.');
  }
  res.redirect('/platform?msg=' + encodeURIComponent('Trial extended by 7 days.'));
});
app.post('/platform/companies/:id/cancel', requirePlatform, async (req, res) => {
  await billing.setStatus(Number(req.params.id), 'canceled');
  await db.billingEvent(Number(req.params.id), 'canceled', 'Subscription canceled by platform admin.');
  res.redirect('/platform?msg=' + encodeURIComponent('Subscription canceled.'));
});
app.post('/platform/companies/:id/delete', requirePlatform, async (req, res) => {
  await db.q('DELETE FROM companies WHERE id=$1', [req.params.id]);
  res.redirect('/platform?msg=' + encodeURIComponent('Company removed.'));
});

// ---------------------------------------------------------------------------
// Seeding + boot
// ---------------------------------------------------------------------------
async function ensurePlatformAdmin() {
  const email = (process.env.PLATFORM_ADMIN_EMAIL || 'platform@rise.local').toLowerCase();
  const password = process.env.PLATFORM_ADMIN_PASSWORD || 'platform123';
  // When a custom platform admin email is configured, remove the built-in
  // default admin account so the starter credentials can never be used.
  if (email !== 'platform@rise.local') {
    await db.q("DELETE FROM users WHERE role='platform' AND email='platform@rise.local'");
  }
  const existing = await db.one('SELECT id FROM users WHERE email=$1', [email]);
  if (!existing) {
    const hash = await auth.hashPassword(password);
    await db.q("INSERT INTO users (company_id, name, email, password_hash, role) VALUES (NULL,'Platform Admin',$1,$2,'platform')", [email, hash]);
    console.log(`[seed] Platform admin created: ${email}`);
  }
}

async function seedDemo() {
  if (process.env.SEED_DEMO !== 'true') return;
  const existing = await db.one("SELECT id FROM companies WHERE name='Demo Doors LLC'");
  if (existing) return;
  const company = await db.one("INSERT INTO companies (name) VALUES ('Demo Doors LLC') RETURNING *");
  const hash = await auth.hashPassword('demo1234');
  const owner = await db.one(
    "INSERT INTO users (company_id, name, email, password_hash, role) VALUES ($1,'Demo Owner','demo@demo.com',$2,'owner') RETURNING *",
    [company.id, hash]);
  void owner;
  await db.q('INSERT INTO subscriptions (company_id, status, trial_end) VALUES ($1,$2,$3)',
    [company.id, 'trialing', new Date(Date.now() + 5 * 86400000)]);
  await db.q('INSERT INTO company_settings (company_id, hourly_rate_cents, tax_percent, parts_multiplier) VALUES ($1, 8500, 8.25, 1.5)', [company.id]);
  await db.billingEvent(company.id, 'trial_started', 'Demo company seeded (5-day trial).');
  const samples = [
    { customer: 'Harbor Point HOA', address: '1200 Lakeshore Dr', phone: '555-0101', poc: 'Dana', desc: 'Gate operator not responding', status: 'bucket' },
    { customer: 'Bluebonnet Storage', address: '44 Industrial Pkwy', phone: '555-0117', poc: 'Mike', desc: 'Roll-up door spring replacement', status: 'bucket' },
    { customer: 'Hill Country Clinic', address: '900 Medical Dr', phone: '555-0130', poc: 'Priya', desc: 'Automatic door sensor alignment', status: 'scheduled', days: 0 },
    { customer: 'Marble Falls ISD', address: '1800 Colt Cir', phone: '555-0142', poc: 'Sam', desc: 'Gym door closer repair', status: 'scheduled', days: 1 },
  ];
  for (const s of samples) {
    const d = s.days !== undefined ? isoDate(new Date(Date.now() + s.days * 86400000)) : null;
    const c = await db.one(
      `INSERT INTO calls (company_id, customer_name, address, phone, poc_name, description, status, scheduled_date, scheduled_time)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *`,
      [company.id, s.customer, s.address, s.phone, s.poc, s.desc, s.status, d, d ? '9:00 AM' : null]);
    await db.q('UPDATE calls SET root_call_id = id WHERE id = $1', [c.id]);
  }
  console.log('[seed] Demo company "Demo Doors LLC" created (demo@demo.com / demo1234).');
}

async function boot() {
  await db.migrate();
  await ensurePlatformAdmin();
  await seedDemo();
  const port = Number(process.env.PORT || 3000);
  app.listen(port, () => {
    console.log(`Rise One Man Show Service listening on :${port} — billing: ${billing.TEST_MODE ? 'TEST MODE (set Stripe env vars to go live)' : 'Stripe (live)'}`);
  });
}

if (require.main === module) {
  boot().catch((e) => {
    console.error('Boot failed:', e);
    process.exit(1);
  });
}

module.exports = { app, boot };
