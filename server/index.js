'use strict';
const path = require('path');
const express = require('express');
const db = require('./db');
const auth = require('./auth');
const billing = require('./billing');
const views = require('./views');
const { esc, dollarsToCents, hoursBetween, computeInvoice, isoDate } = require('./util');

const app = express();

// Stripe webhook needs the raw body for signature verification — register it
// BEFORE any body parsers.
app.post('/webhooks/stripe', express.raw({ type: 'application/json' }), async (req, res) => {
  if (billing.TEST_MODE || !billing.stripe) return res.json({ received: true, testMode: true });
  const sig = req.headers['stripe-signature'];
  let event;
  try {
    event = billing.stripe.webhooks.constructEvent(req.body, sig, process.env.STRIPE_WEBHOOK_SECRET);
  } catch (e) {
    console.error('[stripe] webhook signature failed:', e.message);
    return res.status(400).send('Invalid signature');
  }
  try {
    await billing.applyStripeEvent(event);
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
    prefill = await db.one(
      'SELECT * FROM calls WHERE company_id = $1 AND customer_name = $2 ORDER BY id DESC LIMIT 1',
      [req.companyId, String(req.query.customer)]
    );
  }
  res.send(views.callFormPage({ user: req.user, sub: req.sub, company: req.company, flash: flashFrom(req), call: null, prefill }));
});

app.post('/app/calls', async (req, res) => {
  const b = req.body;
  const scheduled = b.scheduled_date ? 'scheduled' : 'bucket';
  const call = await db.one(
    `INSERT INTO calls (company_id, customer_name, address, phone, poc_name, poc_phone, description, status, scheduled_date, scheduled_time, created_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING *`,
    [req.companyId, b.customer_name, b.address || null, b.phone || null, b.poc_name || null, b.poc_phone || null,
     b.description || null, scheduled, b.scheduled_date || null, b.scheduled_time || null, req.user.id]
  );
  await db.q('UPDATE calls SET root_call_id = id WHERE id = $1', [call.id]);
  res.redirect('/app?msg=' + encodeURIComponent('Call added to the ' + (scheduled === 'scheduled' ? 'schedule.' : 'bucket.')));
});

async function loadCall(req, res, next) {
  const call = await db.one('SELECT * FROM calls WHERE id = $1 AND company_id = $2', [req.params.id, req.companyId]);
  if (!call) return res.status(404).send('Call not found.');
  req.call = call;
  next();
}

app.get('/app/calls/:id/edit', loadCall, (req, res) => {
  res.send(views.callFormPage({ user: req.user, sub: req.sub, company: req.company, flash: flashFrom(req), call: req.call, prefill: null }));
});

app.post('/app/calls/:id/edit', loadCall, async (req, res) => {
  const b = req.body;
  let status = req.call.status;
  let date = b.scheduled_date || null;
  let time = b.scheduled_time || null;
  if (b.unschedule) { status = 'bucket'; date = null; time = null; }
  else if (date && status === 'bucket') status = 'scheduled';
  await db.q(
    `UPDATE calls SET customer_name=$1, address=$2, phone=$3, poc_name=$4, poc_phone=$5, description=$6,
       status=$7, scheduled_date=$8, scheduled_time=$9 WHERE id=$10 AND company_id=$11`,
    [b.customer_name, b.address || null, b.phone || null, b.poc_name || null, b.poc_phone || null,
     b.description || null, status, date, time, req.call.id, req.companyId]
  );
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
      const nc = await db.one(
        `INSERT INTO calls (company_id, customer_name, address, phone, poc_name, poc_phone, description,
           status, scheduled_date, root_call_id, parent_call_id, created_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7,'scheduled',$8,$9,$10,$11) RETURNING *`,
        [req.companyId, req.call.customer_name, req.call.address, req.call.phone, req.call.poc_name,
         req.call.poc_phone, b.follow_up_description || req.call.description, b.follow_up_date, rootId, req.call.id, req.user.id]
      );
      void nc;
    }
  }
  res.redirect(`/app/calls/${req.call.id}/report?msg=` + encodeURIComponent(complete ? 'Report saved — job marked complete.' : 'Report saved.'));
});

// --- Invoice ----------------------------------------------------------------------
app.get('/app/calls/:id/invoice', loadCall, async (req, res) => {
  const result = await invoiceFor(req.call);
  if (!result) return back(res, '/app/completed', 'err', 'No invoice yet — invoices generate when the final call in the chain is marked complete with no follow-up pending.');
  res.send(views.invoicePage({
    user: req.user, sub: req.sub, company: req.company, settings: result.settings,
    rootCall: result.root, inv: result.inv, print: req.query.print === '1',
  }));
});

// --- Completed / Customers ---------------------------------------------------
app.get('/app/completed', async (req, res) => {
  const rows = await db.many(
    "SELECT * FROM calls WHERE company_id = $1 AND status = 'completed' ORDER BY completed_at DESC NULLS LAST, id DESC", [req.companyId]);
  const out = [];
  for (const call of rows) {
    const inv = await invoiceFor(call);
    out.push({ call, hasInvoice: !!inv });
  }
  res.send(views.completedPage({ user: req.user, sub: req.sub, company: req.company, flash: flashFrom(req), rows: out }));
});

app.get('/app/customers', async (req, res) => {
  const qstr = String(req.query.q || '').trim();
  const customers = await db.many(
    `SELECT customer_name, COUNT(*)::int AS call_count,
            (ARRAY_AGG(address ORDER BY id DESC))[1] AS address,
            (ARRAY_AGG(phone ORDER BY id DESC))[1] AS phone
       FROM calls WHERE company_id = $1
        AND ($2 = '' OR customer_name ILIKE $3 OR address ILIKE $3 OR phone ILIKE $3)
      GROUP BY customer_name ORDER BY customer_name`,
    [req.companyId, qstr, '%' + qstr + '%']
  );
  res.send(views.customersPage({ user: req.user, sub: req.sub, company: req.company, flash: flashFrom(req), customers, q: qstr }));
});

app.get('/app/customers/:name', async (req, res) => {
  const name = req.params.name;
  const calls = await db.many('SELECT * FROM calls WHERE company_id = $1 AND customer_name = $2 ORDER BY id DESC', [req.companyId, name]);
  if (!calls.length) return res.status(404).send('Customer not found.');
  res.send(views.customerDetailPage({ user: req.user, sub: req.sub, company: req.company, flash: flashFrom(req), name, calls }));
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
