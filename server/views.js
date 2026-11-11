'use strict';
const { esc, money, daysLeft, mapsUrl, isoDate } = require('./util');
const billing = require('./billing');

function flashHtml(flash) {
  if (!flash) return '';
  return `<div class="flash ${flash.kind || ''}">${esc(flash.msg)}</div>`;
}

// payment_method values: 'card' (Stripe) or a manual label (Cash/Check/...).
function payMethodLabel(method) {
  if (!method) return '';
  return method === 'card' ? 'Card' : method;
}

function paidStamp(call) {
  if (!call || call.payment_status !== 'paid') return '';
  const ref = call.payment_reference ? ` · Ref: ${esc(call.payment_reference)}` : '';
  const when = call.paid_at ? ` · ${isoDate(call.paid_at)}` : '';
  return `<p class="paid-stamp">✓ PAID — ${esc(payMethodLabel(call.payment_method))}${when}${ref}</p>`;
}

// Company profile (Settings -> Company profile): the business's own logo and
// contact block, shown on invoices and proposals. profile is
// { name, address, phone, email, logoDataUrl } — every field optional; a
// missing logo or contact line simply renders nothing. logoDataUrl is a
// data URL stored in the database, inlined straight into the img src.
function profileBlock(profile) {
  if (!profile) return '';
  const contact = [profile.address, profile.phone, profile.email].filter(Boolean);
  return `<div class="company-profile">
    ${profile.logoDataUrl ? `<img class="company-logo" src="${esc(profile.logoDataUrl)}" alt="${esc(profile.name || 'Company logo')}">` : ''}
    <div class="company-profile-name">${esc(profile.name || '')}</div>
    ${contact.map((c) => `<div class="muted">${esc(c)}</div>`).join('')}
  </div>`;
}

function proposalStatusPill(status) {
  const map = {
    draft: ['Draft', 'pill bucket'],
    sent: ['Sent', 'pill sched'],
    approved: ['Approved', 'pill done'],
    changes_requested: ['Changes requested', 'pill warn'],
  };
  const [label, cls] = map[status] || [status, 'pill'];
  return `<span class="${cls}">${label}</span>`;
}

function signatureBlock(proposal) {
  if (!proposal || !proposal.signature_data_url) return '';
  const when = proposal.signed_at ? new Date(proposal.signed_at).toLocaleString() : '';
  return `<div class="signature-block">
    <div class="muted">Signed${when ? ' ' + esc(when) : ''}</div>
    <img class="signature-img" src="${proposal.signature_data_url}" alt="Customer signature">
  </div>`;
}

function invoiceEmailStamp(call) {
  if (!call || !call.invoice_emailed_at) return '';
  const recipient = call.invoice_email_recipient ? ` to ${esc(call.invoice_email_recipient)}` : '';
  return `<p class="muted">✉ Emailed${recipient} on ${isoDate(call.invoice_emailed_at)}</p>`;
}

function subBanner(user, sub) {
  if (!user || user.role === 'platform' || !sub) return '';
  let testTag = billing.TEST_MODE ? ' <span class="tag">Billing: TEST MODE</span>' : '';
  if (sub.status === 'trialing') {
    const d = daysLeft(sub.trial_end);
    return `<div class="banner trial">Free trial — <strong>${d} day${d === 1 ? '' : 's'} left</strong> (ends ${isoDate(sub.trial_end)}). ${user.role === 'owner' ? '<a href="/app/billing">Add a payment method</a> to keep going.' : ''}${testTag}</div>`;
  }
  if (sub.status === 'past_due') {
    return `<div class="banner warn">Payment problem — your subscription is past due. ${user.role === 'owner' ? '<a href="/app/billing">Update your payment method</a>.' : 'Ask your company owner to update billing.'}${testTag}</div>`;
  }
  if (sub.status === 'free') {
    return `<div class="banner subtle">Free access — unlimited users, no charges, courtesy of the platform admin.${testTag}</div>`;
  }
  if (sub.status === 'trial_ended' || sub.status === 'canceled') {
    return `<div class="banner warn">Subscription ${sub.status === 'canceled' ? 'canceled' : 'trial ended'} — the app is locked to billing.${testTag}</div>`;
  }
  return billing.TEST_MODE ? `<div class="banner subtle">Billing is in TEST MODE — no real charges.${testTag}</div>` : '';
}

function layout({ title, user, sub, company, flash, body, print, hideBrand }) {
  const nav = user
    ? `<details class="nav-menu">
        <summary>☰ ${esc(title)}</summary>
        <div class="menu-links">
        ${user.role === 'platform'
          ? '<a href="/platform">Platform</a>'
          : `<a href="/app">Schedule</a>
             <a href="/app/completed">Completed</a>
             <a href="/app/customers">Customers</a>
             ${user.role !== 'tech' ? '<a href="/app/proposals">Proposals</a>' : ''}
             ${user.role !== 'tech' ? '<a href="/app/price-book">Price Book</a>' : ''}
             <a href="/app/log">Log &amp; Report</a>
             ${user.role !== 'tech' ? '<a href="/app/users">Users</a>' : ''}
             ${user.role !== 'tech' ? '<a href="/app/settings">Settings</a>' : ''}
             ${user.role === 'owner' ? '<a href="/app/billing">Billing</a>' : ''}
             <a href="/platform">Platform</a>`}
        <form method="post" action="/logout" class="logout"><button type="submit">Log out</button></form>
        </div>
      </details>`
    : '';
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)} · Rise One Man Show</title>
<link rel="stylesheet" href="/style.css">
<link rel="icon" type="image/png" href="/favicon.png">
<link rel="apple-touch-icon" href="/apple-touch-icon.png">
</head><body class="${print ? 'print' : ''}">
${hideBrand ? '' : `<header class="brand">
  <img class="logo-img" src="/logo-mark.png" alt="Rise One Man Show">
  <div class="wordmark"><span class="brand-rise">RISE</span> <span>ONE MAN SHOW</span></div>
  ${company ? `<div class="company-name">${esc(company.name)}</div>` : ''}
</header>`}
${nav}
${subBanner(user, sub)}
<main>${flashHtml(flash)}${body}</main>
${print ? '' : '<footer class="site-footer"><a href="/terms.html">Terms of Service</a> · <a href="/privacy.html">Privacy Policy</a></footer>'}
<script src="/app.js"></script>
</body></html>`;
}

// Shared plan presentation. tierRows is a tiers.js TIERS array (or subset).
function tierTableHtml(tierRows) {
  return `<table class="inv-table">
    <tr><th>Plan</th><th>Users</th><th class="r">Monthly</th><th class="r">Per user</th></tr>
    ${tierRows.map((t) => `<tr><td><strong>${esc(t.label)}</strong></td><td>${t.seats === 1 ? '1 user' : `Up to ${t.seats} users`}</td><td class="r">${money(t.monthlyCents)}</td><td class="r">${money(Math.round(t.monthlyCents / t.seats))}</td></tr>`).join('')}
  </table>`;
}

function landingPage(flash) {
  const body = `
  <section class="hero">
    <h1>Run the whole job from your phone.</h1>
    <p>New call comes in. Book it. Drive it. Fix it. Invoice it. Field management
       software for solo and small field-service businesses — scheduling, job
       reports, invoicing, mileage and hours in one place.</p>
    <p class="price">7-day free trial on any plan · upgrade anytime, prorated · cancel anytime</p>
    <div class="cta-row">
      <a class="btn primary" href="/signup">Start free trial</a>
      <a class="btn" href="/demo.html">Try the demo</a>
      <a class="btn" href="/login">Log in</a>
    </div>
    <div class="cta-row">
      <button class="btn" type="button" data-open="pricing-sheet">See pricing</button>
    </div>
  </section>
  <div class="sheet" id="pricing-sheet" hidden>
    <div class="card wide">
      <h3>Pricing</h3>
      ${tierTableHtml(billing.tiers.TIERS)}
      <div class="cta-row">
        <a class="btn primary" href="/signup">Start free trial</a>
        <button class="btn" type="button" data-close>Close</button>
      </div>
    </div>
  </div>`;
  return layout({ title: 'Field Management Software', flash, body });
}

function loginPage(flash) {
  const body = `
  <section class="card narrow">
    <h2>Log in</h2>
    <form method="post" action="/login">
      <label>Email <input type="email" name="email" required autocomplete="email"></label>
      <label>Password <input type="password" name="password" required autocomplete="current-password"></label>
      <button class="btn primary wide" type="submit">Log in</button>
    </form>
    <p class="muted">Forgot your password? Ask your company owner to reset it from the Users page (or the platform admin).</p>
    <p class="muted">No account yet? <a href="/signup">Start a 7-day free trial</a>.</p>
  </section>`;
  return layout({ title: 'Log in', flash, body });
}

function signupPage(flash, tiersList) {
  const tiers = tiersList && tiersList.length ? tiersList : billing.tiers.TIERS;
  const body = `
  <section class="card narrow">
    <h2>Create your company</h2>
    <p class="muted">7-day free trial starts today, on any plan. After that, your plan bills monthly — add a card before the trial ends to keep the app unlocked.</p>
    <form method="post" action="/signup">
      <label>Company name <input name="company_name" required></label>
      <label>Your name <input name="owner_name" required autocomplete="name"></label>
      <label>Email <input type="email" name="email" required autocomplete="email"></label>
      <label>Password <input type="password" name="password" required minlength="8" autocomplete="new-password"></label>
      <fieldset><legend>Choose your plan</legend>
        ${tiers.map((t, i) => `<label class="check"><input type="radio" name="plan_tier" value="${esc(t.id)}" ${i === 0 ? 'checked' : ''}>
          <strong>${esc(t.label)}</strong> — ${money(t.monthlyCents)}/month (${t.seats === 1 ? '1 user' : `up to ${t.seats} users`}, ${money(Math.round(t.monthlyCents / t.seats))} per user)</label>`).join('')}
      </fieldset>
      <p class="muted">You can switch plans anytime from the Billing page — changes are prorated.</p>
      <button class="btn primary wide" type="submit">Create company &amp; start trial</button>
    </form>
  </section>`;
  return layout({ title: 'Sign up', flash, body });
}

// --- App pages -------------------------------------------------------------

function statusPill(call) {
  const map = {
    bucket: ['Bucket', 'pill bucket'],
    scheduled: ['Scheduled', 'pill sched'],
    traveling: ['Traveling', 'pill travel'],
    on_job: ['On the job', 'pill job'],
    completed: ['Completed', 'pill done'],
  };
  const [label, cls] = map[call.status] || [call.status, 'pill'];
  return `<span class="${cls}">${label}</span>`;
}

function callCard(call, { showOpen = true } = {}) {
  return `<div class="card call-card">
    <div class="call-head"><strong>${esc(call.customer_name)}</strong> ${statusPill(call)}
      ${call.parent_call_id ? '<span class="tag">↩ Follow-up</span>' : ''}</div>
    <div class="call-desc">${esc(call.description || '')}</div>
    ${call.assignee_name !== undefined ? `<div class="muted">👤 ${esc(call.assignee_name || 'Unassigned')}</div>` : ''}
    ${call.address ? `<div><a href="${mapsUrl(call.address)}" target="_blank" rel="noopener">📍 ${esc(call.address)}</a></div>` : ''}
    ${call.scheduled_date ? `<div class="sched-time">🗓 ${isoDate(call.scheduled_date)}${call.scheduled_time ? ' · ' + esc(call.scheduled_time) : ''}</div>` : ''}
    <div class="row-actions">
      ${showOpen && call.status !== 'completed' ? `<a class="btn small teal" href="/app/calls/${call.id}">Open job</a>` : ''}
      <a class="btn small" href="/app/calls/${call.id}/edit">Edit</a>
      ${call.status === 'completed' ? `<a class="btn small green" href="/app/calls/${call.id}/report">📋 Report</a>` : ''}
    </div>
  </div>`;
}

function schedulePage({ user, sub, company, flash, bucket, byDay, todayGas, todayMaint, assignees = [], techFilter = null, canFilter = false }) {
  let body = `<div class="page-head"><h2>Schedule</h2>
    <span class="bucket-count">${bucket.length} in the Bucket</span></div>`;
  if (canFilter) {
    body += `<form method="get" action="/app" class="row-actions">
      <label style="flex:1;min-width:220px">Show schedule for
        <select name="tech">
          <option value="">All team members</option>
          ${assignees.map((u) => `<option value="${u.id}"${techFilter === u.id ? ' selected' : ''}>${esc(u.name)} (${esc(u.role)})</option>`).join('')}
        </select>
      </label>
      <button class="btn small" type="submit">Show</button>
    </form>`;
  }

  body += `<section><h3>🪣 Bucket — unscheduled calls</h3>`;
  body += bucket.length ? bucket.map((c) => callCard(c)).join('') : '<p class="muted">No unscheduled calls.</p>';
  body += `</section>`;

  const days = Object.keys(byDay).sort();
  body += `<section><h3>On the schedule</h3>`;
  if (!days.length) body += '<p class="muted">Nothing scheduled yet. Open a bucket call to put it on the schedule.</p>';
  for (const day of days) {
    body += `<h4 class="day-head">${esc(day)}</h4>` + byDay[day].map((c) => callCard(c)).join('');
  }
  body += `</section>`;

  body += `<section class="card"><h3>Today</h3>
    <p>⛽ Gas today: <strong>${money(todayGas.reduce((s, g) => s + g.amount_cents, 0))}</strong>
       · 🔧 Maintenance today: <strong>${money(todayMaint.reduce((s, m) => s + m.amount_cents, 0))}</strong></p>
    <div class="row-actions">
      <button class="btn round" data-open="gas-sheet">⛽ Add gas</button>
      <button class="btn round" data-open="maint-sheet">🔧 Add maintenance</button>
    </div>
    ${todayGas.map((g) => `<div class="line">⛽ ${money(g.amount_cents)} ${g.gallons ? esc(g.gallons) + ' gal' : ''} ${esc(g.note || '')} <form method="post" action="/app/gas/${g.id}/delete" class="inline"><button class="link danger">delete</button></form></div>`).join('')}
    ${todayMaint.map((m) => `<div class="line">🔧 ${money(m.amount_cents)} — ${esc(m.work_done || '')} ${m.shop ? '@ ' + esc(m.shop) : ''} <form method="post" action="/app/maintenance/${m.id}/delete" class="inline"><button class="link danger">delete</button></form></div>`).join('')}
  </section>`;

  body += `
  <div class="sheet" id="gas-sheet" hidden>
    <form method="post" action="/app/gas" class="card">
      <h3>Add gas purchase</h3>
      <label>Date <input type="date" name="date" value="${isoDate(new Date())}"></label>
      <label>Total ($) <input name="amount" inputmode="decimal" required></label>
      <label>Gallons <input name="gallons" inputmode="decimal"></label>
      <label>Note <input name="note"></label>
      <label>Receipt photo <input type="file" accept="image/*" data-photo-input="receipt_photo"></label>
      <input type="hidden" name="receipt_photo">
      <div class="thumb-row"></div>
      <button class="btn primary" type="submit">Save gas</button>
      <button class="btn" type="button" data-close>Cancel</button>
    </form>
  </div>
  <div class="sheet" id="maint-sheet" hidden>
    <form method="post" action="/app/maintenance" class="card">
      <h3>Add maintenance</h3>
      <label>Date <input type="date" name="date" value="${isoDate(new Date())}"></label>
      <label>Total ($) <input name="amount" inputmode="decimal" required></label>
      <label>Work done <input name="work_done"></label>
      <label>Shop <input name="shop"></label>
      <label>Note <input name="note"></label>
      <label>Receipt photo <input type="file" accept="image/*" data-photo-input="receipt_photo"></label>
      <input type="hidden" name="receipt_photo">
      <div class="thumb-row"></div>
      <button class="btn primary" type="submit">Save maintenance</button>
      <button class="btn" type="button" data-close>Cancel</button>
    </form>
  </div>
  <a class="fab" href="/app/calls/new" title="New call" aria-label="New call"></a>`;
  return layout({ title: 'Schedule', user, sub, company, flash, body });
}

function callFormPage({ user, sub, company, flash, call, prefill, assignees = [], canAssign = false }) {
  const c = call || prefill || {};
  const editing = !!call;
  const body = `
  <section class="card">
    <h2>${editing ? 'Edit call' : 'New call'}</h2>
    <form method="post" action="${editing ? `/app/calls/${call.id}/edit` : '/app/calls'}">
      <label>Customer name <input name="customer_name" required value="${esc(c.customer_name || '')}"></label>
      ${canAssign ? `<label>Assigned to
        <select name="assigned_user_id">
          <option value="">Unassigned</option>
          ${assignees.map((u) => `<option value="${u.id}"${c.assigned_user_id === u.id ? ' selected' : ''}>${esc(u.name)} (${esc(u.role)})</option>`).join('')}
        </select>
      </label>` : ''}
      <label>Address <input name="address" value="${esc(c.address || '')}"></label>
      <label>Phone <input name="phone" value="${esc(c.phone || '')}"></label>
      <label>Customer email (for invoicing) <input type="email" name="customer_email" value="${esc(c.customer_email || '')}"></label>
      <label>Point of contact <input name="poc_name" value="${esc(c.poc_name || '')}"></label>
      <label>POC phone <input name="poc_phone" value="${esc(c.poc_phone || '')}"></label>
      <label>Job description <textarea name="description" rows="3">${esc(c.description || '')}</textarea></label>
      ${editing ? `
      <fieldset><legend>Schedule</legend>
        <label>Date <input type="date" name="scheduled_date" value="${c.scheduled_date ? isoDate(c.scheduled_date) : ''}"></label>
        <label>Time <input name="scheduled_time" value="${esc(c.scheduled_time || '')}" placeholder="8:00 AM"></label>
        <label class="check"><input type="checkbox" name="unschedule" value="1"> Back to bucket (unschedule)</label>
      </fieldset>` : `
      <fieldset><legend>Schedule now (optional)</legend>
        <label>Date <input type="date" name="scheduled_date"></label>
        <label>Time <input name="scheduled_time" placeholder="8:00 AM"></label>
      </fieldset>`}
      <button class="btn primary wide" type="submit">${editing ? 'Save call' : 'Add call'}</button>
    </form>
    ${editing ? `<form method="post" action="/app/calls/${call.id}/delete" onsubmit="return confirm('Delete this call?')"><button class="btn danger wide">Delete call</button></form>` : ''}
  </section>`;
  return layout({ title: editing ? 'Edit call' : 'New call', user, sub, company, flash, body });
}

module.exports = { layout, esc, landingPage, loginPage, signupPage, schedulePage, callFormPage, statusPill, callCard };

// --- Job run screen --------------------------------------------------------

function jobPage({ user, sub, company, flash, call, report, openPunch, openTrip, chainHours, chainMiles, invoiceReady, proposals = [], canManage = false }) {
  const phase = call.status;
  let actions = '';
  if (phase === 'bucket' || phase === 'scheduled') {
    actions = `<form method="post" action="/app/calls/${call.id}/start-travel">
      <button class="btn primary wide big">🚗 Start travel</button></form>`;
  } else if (phase === 'traveling') {
    actions = `
      <div class="card inner">
        <p>Traveling… ${openTrip ? `started ${new Date(openTrip.started_at).toLocaleTimeString()}` : ''}</p>
        <p class="muted">GPS miles: <strong id="gps-miles">0.00</strong> mi
          <button type="button" class="btn small" id="gps-start">Start GPS</button>
          <span class="muted" id="gps-status"></span></p>
        <form method="post" action="/app/calls/${call.id}/start-job">
          <input type="hidden" name="miles" id="miles-input" value="">
          <label>Travel miles (auto from GPS, or type them)
            <input name="miles_manual" id="miles-manual" inputmode="decimal" placeholder="0.0"></label>
          <button class="btn primary wide big" type="submit">▶ Start job</button>
        </form>
        <form method="post" action="/app/calls/${call.id}/cancel-travel" onsubmit="return confirm('Cancel this travel leg?')">
          <button class="btn wide">Cancel travel</button></form>
      </div>`;
  } else if (phase === 'on_job') {
    actions = `
      <div class="card inner">
        <p>On the job ${openPunch ? `since ${new Date(openPunch.clock_in).toLocaleTimeString()}` : ''}
           · <strong class="live-timer" data-since="${openPunch ? new Date(openPunch.clock_in).toISOString() : ''}">--:--:--</strong></p>
        <a class="btn teal wide big" href="/app/calls/${call.id}/report">📋 Job report ${report && report.complete ? '✓' : ''}</a>
        <form method="post" action="/app/calls/${call.id}/end-call">
          <button class="btn primary wide big" ${report && report.complete ? '' : 'disabled title="Mark the job complete in the report first"'}>
            ■ End call</button>
        </form>
        ${report && report.complete ? '' : '<p class="muted">End call unlocks once the job is marked complete in the report.</p>'}
      </div>`;
  } else if (phase === 'completed') {
    actions = `
      <div class="row-actions">
        <a class="btn green" href="/app/calls/${call.id}/report">📋 Report</a>
        ${invoiceReady ? `<a class="btn blue" href="/app/calls/${call.id}/invoice">🧾 Invoice</a>` : ''}
      </div>`;
  }

  // Proposals are owner/admin only — techs never see this section, and
  // proposal pages themselves are gated the same way server-side.
  const proposalSection = !canManage ? '' : `
  <section class="card"><h3>Proposals</h3>
    ${proposals.length ? proposals.map((p) => `
      <div class="line proposal-line">
        <div>
          <strong>${money(p.totals ? p.totals.totalCents : 0)}</strong> ${proposalStatusPill(p.status)}
          <span class="muted">${p.display_mode === 'total_only' ? '· Total only' : '· Itemized'}${p.sent_at ? ' · Sent ' + new Date(p.sent_at).toLocaleDateString() : ''}</span>
          ${p.customer_note ? `<div class="muted">Note: ${esc(p.customer_note)}</div>` : ''}
          ${p.status === 'changes_requested' && p.customer_decision_note ? `<div><strong>Customer asked for changes:</strong> ${esc(p.customer_decision_note)}</div>` : ''}
          ${signatureBlock(p)}
        </div>
        <div class="row-actions">
          <a class="btn small" href="/app/calls/${call.id}/proposals/${p.id}">View</a>
          ${(p.status === 'draft' || p.status === 'changes_requested') ? `<a class="btn small" href="/app/calls/${call.id}/proposals/${p.id}/edit">Edit</a>` : ''}
          ${p.status === 'draft' ? `<form method="post" action="/app/calls/${call.id}/proposals/${p.id}/send" class="inline"><button class="btn small teal" type="submit">Send</button></form>` : ''}
          ${p.status === 'changes_requested' ? `<form method="post" action="/app/calls/${call.id}/proposals/${p.id}/send" class="inline"><button class="btn small teal" type="submit">Resend</button></form>` : ''}
        </div>
      </div>`).join('') : '<p class="muted">No proposals yet for this call.</p>'}
    <div class="row-actions"><a class="btn small teal" href="/app/calls/${call.id}/proposals/new">+ New proposal</a></div>
  </section>`;

  const body = `
  <section class="card">
    <div class="call-head"><h2>${esc(call.customer_name)} — ${esc(call.description || 'Job')}</h2> ${statusPill(call)}</div>
    ${call.address ? `<p><a href="${mapsUrl(call.address)}" target="_blank" rel="noopener">📍 ${esc(call.address)}</a></p>` : ''}
    ${call.phone ? `<p>📞 ${esc(call.phone)}</p>` : ''}
    ${call.poc_name ? `<p>Contact: ${esc(call.poc_name)}${call.poc_phone ? ' · ' + esc(call.poc_phone) : ''}</p>` : ''}
    <p class="muted">Chain totals so far: <strong>${chainHours.toFixed(2)} hrs</strong> · <strong>${Number(chainMiles).toFixed(1)} mi</strong></p>
    ${actions}
    <div class="row-actions">
      <a class="btn small" href="/app/calls/${call.id}/edit">Edit call</a>
      <a class="btn small" href="/app">Back to schedule</a>
    </div>
  </section>
  ${proposalSection}`;
  return layout({ title: call.customer_name, user, sub, company, flash, body });
}

// --- Proposals (owner/admin in-app; public page below) -----------------------

function proposalsPage({ user, sub, company, flash, proposals }) {
  const rows = (proposals || []).map(({ proposal: p, call, totals }) => `
    <div class="line proposal-line">
      <div>
        <strong>${esc(call.customer_name)}</strong> — ${esc(call.description || 'Job')}
        <div><strong>${money(totals ? totals.totalCents : 0)}</strong> ${proposalStatusPill(p.status)}
        <span class="muted">${p.display_mode === 'total_only' ? '· Total only' : '· Itemized'}${p.sent_at ? ' · Sent ' + new Date(p.sent_at).toLocaleDateString() : ''}</span></div>
        ${p.status === 'changes_requested' && p.customer_decision_note ? `<div><strong>Customer asked for changes:</strong> ${esc(p.customer_decision_note)}</div>` : ''}
        ${p.status === 'approved' && p.signed_at ? `<div class="muted">Signed ${esc(new Date(p.signed_at).toLocaleString())}</div>` : ''}
      </div>
      <div class="row-actions">
        <a class="btn small" href="/app/calls/${call.id}/proposals/${p.id}">View</a>
        <a class="btn small" href="/app/calls/${call.id}">Open job</a>
      </div>
    </div>`).join('');
  const body = `
  <section class="card"><h2>Proposals sent</h2>
    ${rows || '<p class="muted">No proposals sent yet.</p>'}
  </section>`;
  return layout({ title: 'Proposals', user, sub, company, flash, body });
}

function proposalFormPage({ user, sub, company, flash, call, proposal, settings }) {
  const p = proposal || {};
  const items = Array.isArray(p.items) ? p.items : [];
  const editing = !!proposal;
  const mult = Number(settings && settings.parts_multiplier != null ? settings.parts_multiplier : 1);
  const itemRows = (items.length ? items : [{ qty: '', description: '', unitCostCents: '' }]).map((it) => `
    <div class="part-row">
      <input name="item_qty" type="number" step="any" min="0" placeholder="Qty" value="${it.qty !== undefined && it.qty !== '' ? esc(it.qty) : ''}">
      <input name="item_desc" placeholder="Description" value="${esc(it.description || '')}">
      <input name="item_cost" inputmode="decimal" placeholder="Unit cost $" value="${it.unitCostCents !== undefined && it.unitCostCents !== '' ? (Number(it.unitCostCents) / 100).toFixed(2) : ''}">
      <button type="button" class="btn small danger" data-remove-part>✕</button>
    </div>`).join('');
  const body = `
  <section class="card">
    <h2>${editing ? 'Edit proposal' : 'New proposal'}</h2>
    <p><strong>${esc(call.customer_name)}</strong> — ${esc(call.description || '')}</p>
    ${p.status === 'changes_requested' && p.customer_decision_note ? `<p><strong>Customer asked for changes:</strong> ${esc(p.customer_decision_note)}</p>` : ''}
    <form method="post" action="${editing ? `/app/calls/${call.id}/proposals/${p.id}/edit` : `/app/calls/${call.id}/proposals`}">
      <fieldset><legend>Labor — separate from parts</legend>
        <label>Estimated hours to complete <input name="labor_hours" type="number" step="any" min="0" placeholder="e.g. 4.5" value="${p.labor_hours !== null && p.labor_hours !== undefined ? esc(p.labor_hours) : ''}"></label>
        <p class="muted">Billed at your hourly rate ${money(settings ? settings.hourly_rate_cents : 0)}/hr from Settings → Invoicing. Leave blank for no labor line.</p>
      </fieldset>
      <fieldset><legend>Line items — Quantity · Description · Unit cost</legend>
        <div id="parts">${itemRows}</div>
        <button type="button" class="btn small" id="add-part">+ Add another line</button>
      </fieldset>
      <p class="muted">Tax (${esc(settings ? settings.tax_percent : 0)}%) is added automatically from Settings → Invoicing.${mult !== 1 ? ` Parts are billed at ${mult}× cost (parts multiplier).` : ''}</p>
      <fieldset><legend>What the customer sees</legend>
        <label class="check"><input type="radio" name="display_mode" value="itemized" ${p.display_mode !== 'total_only' ? 'checked' : ''}> Itemized — every line, then the total</label>
        <label class="check"><input type="radio" name="display_mode" value="total_only" ${p.display_mode === 'total_only' ? 'checked' : ''}> Total only — just the final amount</label>
      </fieldset>
      <label>Note to the customer (optional) <textarea name="customer_note" rows="3">${esc(p.customer_note || '')}</textarea></label>
      <button class="btn primary wide" type="submit">${editing ? 'Save proposal' : 'Create proposal'}</button>
    </form>
    <div class="row-actions"><a class="btn small" href="/app/calls/${call.id}">Back to job</a></div>
  </section>`;
  return layout({ title: editing ? 'Edit proposal' : 'New proposal', user, sub, company, flash, body });
}

function proposalDetailPage({ user, sub, company, flash, call, proposal, totals, settings, recipientEmail, resendConfigured }) {
  const p = proposal;
  const itemized = p.display_mode !== 'total_only';
  const laborRow = totals.laborCents > 0 ? `<tr><td>Labor — ${esc(totals.laborHours)} hrs × ${money(totals.laborRateCents)}/hr</td><td class="r">${money(totals.laborCents)}</td></tr>` : '';
  const rows = itemized ? totals.lines.map((l) => `<tr><td>${esc(l.description)} — ${l.qty} × ${money(l.unitCostCents)}${totals.multiplierApplied ? ' (× multiplier)' : ''}</td><td class="r">${money(l.lineCents)}</td></tr>`).join('') : '';
  let actions = '';
  if (p.status === 'draft') {
    actions = `<form method="post" action="/app/calls/${call.id}/proposals/${p.id}/send" class="inline">
        <button class="btn teal" type="submit">Send to customer</button></form>
      <a class="btn" href="/app/calls/${call.id}/proposals/${p.id}/edit">Edit</a>`;
  } else if (p.status === 'changes_requested') {
    actions = `<form method="post" action="/app/calls/${call.id}/proposals/${p.id}/send" class="inline">
        <button class="btn teal" type="submit">Resend to customer</button></form>
      <a class="btn" href="/app/calls/${call.id}/proposals/${p.id}/edit">Edit</a>`;
  }
  const body = `
  <section class="card">
    <h2>Proposal ${proposalStatusPill(p.status)}</h2>
    <p><strong>${esc(call.customer_name)}</strong> — ${esc(call.description || '')}</p>
    ${p.customer_note ? `<p><strong>Note sent:</strong> ${esc(p.customer_note)}</p>` : ''}
    ${p.status === 'changes_requested' && p.customer_decision_note ? `<p><strong>Customer asked for changes:</strong> ${esc(p.customer_decision_note)}</p>` : ''}
    ${p.sent_at ? `<p class="muted">Sent ${new Date(p.sent_at).toLocaleString()}${p.emailed_to ? ' to ' + esc(p.emailed_to) : ''}</p>` : ''}
    ${signatureBlock(p)}
    <table class="inv-table">
      <tr><th>Description</th><th class="r">Amount</th></tr>
      ${itemized ? laborRow + rows : `<tr><td>Proposal total (customer sees total only)</td><td class="r">${money(totals.totalCents)}</td></tr>`}
      ${itemized ? `<tr><td>Subtotal</td><td class="r">${money(totals.subtotalCents)}</td></tr>
      <tr><td>Tax (${esc(settings ? settings.tax_percent : 0)}%)</td><td class="r">${money(totals.taxCents)}</td></tr>` : ''}
      <tr class="total"><td>Total</td><td class="r">${money(totals.totalCents)}</td></tr>
    </table>
    ${totals.multiplierApplied ? '<p class="muted">Parts billed at a markup over cost (parts multiplier applied).</p>' : ''}
    ${!resendConfigured && (p.status === 'draft' || p.status === 'changes_requested') ? '<p class="muted">Email sending is not configured on the server yet (needs RESEND_API_KEY) — sending will show a notice until it is.</p>' : ''}
    <div class="row-actions">${actions}
      <a class="btn small" href="/app/calls/${call.id}">Back to job</a>
    </div>
    ${recipientEmail ? `<p class="muted">Customer email on file: ${esc(recipientEmail)}</p>` : '<p class="muted">No customer email on file — add one on the call or Customers page before sending.</p>'}
  </section>`;
  return layout({ title: 'Proposal', user, sub, company, flash, body });
}

// --- Public proposal page (/proposal/:token, no login) ------------------------
// The customer sees the company's logo/info, the proposal (lines or total
// only, per the owner's display choice), and — while it is still awaiting a
// decision — two buttons: Approve (signature required) and Request changes
// (a note is required). After a decision, the buttons are gone and the
// recorded decision (and signature, when approved) is shown instead.
function proposalPage({ company, call, proposal, totals, profile, flash }) {
  const p = proposal;
  const itemized = p.display_mode !== 'total_only';
  const decided = p.status === 'approved' || p.status === 'changes_requested';
  const laborRow = totals.laborCents > 0 ? `<tr><td>Labor — ${esc(totals.laborHours)} hrs × ${money(totals.laborRateCents)}/hr</td><td class="r">${money(totals.laborCents)}</td></tr>` : '';
  const rows = itemized ? totals.lines.map((l) => `<tr><td>${esc(l.description)} — ${l.qty} × ${money(l.unitCostCents)}${totals.multiplierApplied ? ' (× multiplier)' : ''}</td><td class="r">${money(l.lineCents)}</td></tr>`).join('') : '';
  let decision = '';
  if (p.status === 'approved') {
    decision = `<div class="flash ok">✓ Approved${p.decided_at ? ' on ' + esc(new Date(p.decided_at).toLocaleString()) : ''} — thank you!</div>${signatureBlock(p)}`;
  } else if (p.status === 'changes_requested') {
    decision = `<div class="flash">Changes requested${p.decided_at ? ' on ' + esc(new Date(p.decided_at).toLocaleString()) : ''} — we've noted what to adjust and will send a revised proposal.</div>
      ${p.customer_decision_note ? `<p><strong>Your note:</strong> ${esc(p.customer_decision_note)}</p>` : ''}`;
  }
  const actions = decided ? '' : `
    <form method="post" action="/proposal/${esc(p.token)}/approve" id="approve-form" class="card inner">
      <h3>Approve this proposal</h3>
      <p class="muted">Sign below to approve. Your signature and the date &amp; time are recorded with the proposal.</p>
      <canvas id="sig-pad" class="sig-pad" width="420" height="160"></canvas>
      <input type="hidden" name="signature_data_url" id="sig-data" value="">
      <p class="err-text" id="sig-error" hidden>Please sign in the box above before approving.</p>
      <div class="row-actions">
        <button type="button" class="btn small" id="sig-clear">Clear signature</button>
        <button class="btn green" type="submit">✓ Approve — ${money(totals.totalCents)}</button>
      </div>
    </form>
    <form method="post" action="/proposal/${esc(p.token)}/request-changes" class="card inner">
      <h3>Request changes</h3>
      <label>What should change? <textarea name="note" rows="3" required placeholder="Tell us what to adjust…"></textarea></label>
      <button class="btn" type="submit">Request changes</button>
    </form>`;
  const body = `
  <section class="invoice">
    <div class="inv-head">
      <div><h2>PROPOSAL</h2><p>${esc(company.name)}</p></div>
    </div>
    ${profileBlock(profile)}
    <p><strong>Job:</strong> ${esc(call.customer_name)} — ${esc(call.description || '')}</p>
    ${p.customer_note ? `<p>${esc(p.customer_note)}</p>` : ''}
    <table class="inv-table">
      <tr><th>Description</th><th class="r">Amount</th></tr>
      ${itemized ? laborRow + rows : ''}
      ${itemized ? `<tr><td>Subtotal</td><td class="r">${money(totals.subtotalCents)}</td></tr>
      <tr><td>Tax</td><td class="r">${money(totals.taxCents)}</td></tr>` : ''}
      <tr class="total"><td>Total</td><td class="r">${money(totals.totalCents)}</td></tr>
    </table>
    ${decision}
    ${actions}
    <p class="muted" style="text-align:center;margin-top:18px">Powered by Rise One Man Show</p>
  </section>`;
  return layout({ title: 'Proposal', flash, body, hideBrand: true });
}

// --- Job report --------------------------------------------------------------

function reportPage({ user, sub, company, flash, call, report, chainHours, chainMiles, print, priceBook }) {
  const r = report || {};
  const parts = Array.isArray(r.parts) ? r.parts : [];
  const photos = Array.isArray(r.photos) ? r.photos : [];
  const book = Array.isArray(priceBook) ? priceBook : [];
  const bookDesc = (p) => [p.name, p.part_number, p.description].filter((x) => x).join(' — ');
  const bookPicker = !print && book.length ? `
        <div class="row-actions">
          <select id="price-book-pick" style="flex:1">
            <option value="">Add from price book…</option>
            ${book.map((p) => `<option value="${p.id}" data-desc="${esc(bookDesc(p))}" data-cost="${(Number(p.cost_cents) / 100).toFixed(2)}">${esc(p.name)}${p.part_number ? ' — ' + esc(p.part_number) : ''} — ${money(p.cost_cents)}</option>`).join('')}
          </select>
          <button type="button" class="btn small" id="add-price-book-part">Add part</button>
        </div>` : '';
  const partRows = (parts.length ? parts : [{ qty: '', description: '', costCents: '' }]).map((p) => `
    <div class="part-row">
      <input name="part_qty" type="number" step="any" min="0" placeholder="Qty" value="${p.qty !== undefined && p.qty !== '' ? esc(p.qty) : ''}">
      <input name="part_desc" placeholder="Description" value="${esc(p.description || '')}">
      <input name="part_cost" inputmode="decimal" placeholder="Cost $" value="${p.costCents !== undefined && p.costCents !== '' ? (Number(p.costCents) / 100).toFixed(2) : ''}">
      <button type="button" class="btn small danger" data-remove-part>✕</button>
    </div>`).join('');

  const form = print ? '' : `
    <form method="post" action="/app/calls/${call.id}/report" id="report-form">
      <label>Asset worked on <input name="asset_name" value="${esc(r.asset_name || '')}"></label>
      <div class="grid3">
        <label>Make <input name="asset_make" value="${esc(r.asset_make || '')}"></label>
        <label>Model <input name="asset_model" value="${esc(r.asset_model || '')}"></label>
        <label>Serial # <input name="asset_serial" value="${esc(r.asset_serial || '')}"></label>
      </div>
      <label>Location on site <input name="location_on_site" value="${esc(r.location_on_site || '')}"></label>
      <label>Work performed <textarea name="work_performed" rows="4">${esc(r.work_performed || '')}</textarea></label>
      <fieldset><legend>Parts used — Quantity · Description · Cost</legend>
        ${bookPicker}
        <div id="parts">${partRows}</div>
        <button type="button" class="btn small" id="add-part">+ Add another part</button>
      </fieldset>
      <label>Photos
        <input type="file" accept="image/*" multiple data-photo-multi="photos"></label>
      <input type="hidden" name="photos_json" id="photos-json" value='${esc(JSON.stringify(photos))}'>
      <div class="thumb-row" id="photo-thumbs">${photos.map((p) => `<img class="thumb" src="${p}">`).join('')}</div>
      <label class="check"><input type="checkbox" name="follow_up" value="1" id="follow-up-check" ${r.follow_up ? 'checked' : ''}> Follow-up needed</label>
      <div id="follow-up-box" ${r.follow_up ? '' : 'hidden'}>
        <label>Follow-up date <input type="date" name="follow_up_date" value="${r.follow_up_date ? isoDate(r.follow_up_date) : ''}"></label>
        <label>Follow up description <textarea name="follow_up_description" rows="2">${esc(r.follow_up_description || '')}</textarea></label>
      </div>
      <label>Notes <textarea name="notes" rows="3">${esc(r.notes || '')}</textarea></label>
      <label class="check"><input type="checkbox" name="complete" value="1" ${r.complete ? 'checked' : ''}> Mark job complete</label>
      <button class="btn primary wide" type="submit">Save report</button>
    </form>`;

  const readOnly = print ? `
    <div class="print-report">
      <p><strong>Asset:</strong> ${esc(r.asset_name || '')} ${esc(r.asset_make || '')} ${esc(r.asset_model || '')} ${r.asset_serial ? '· Serial ' + esc(r.asset_serial) : ''}</p>
      <p><strong>Location on site:</strong> ${esc(r.location_on_site || '')}</p>
      <p><strong>Work performed:</strong></p><p>${esc(r.work_performed || '')}</p>
      ${parts.length ? `<p><strong>Parts used:</strong></p><ul>${parts.map((p) => `<li>${esc(p.qty)} × ${esc(p.description)} — ${money(p.costCents)} ea.</li>`).join('')}</ul>` : ''}
      ${r.notes ? `<p><strong>Notes:</strong> ${esc(r.notes)}</p>` : ''}
      <p><strong>Status:</strong> ${r.complete ? 'Complete' : 'In progress'}${r.follow_up ? ` · Follow-up: ${r.follow_up_date ? isoDate(r.follow_up_date) : ''}` : ''}</p>
      ${photos.length ? `<div class="thumb-row">${photos.map((p) => `<img class="thumb" src="${p}">`).join('')}</div>` : ''}
    </div>` : '';

  const body = `
  <section class="card">
    <h2>📋 Job report</h2>
    <p><strong>${esc(call.customer_name)}</strong> — ${esc(call.description || '')}<br>
       ${call.scheduled_date ? isoDate(call.scheduled_date) : ''} · ${chainHours.toFixed(2)} hrs · ${Number(chainMiles).toFixed(1)} mi on this job chain</p>
    ${form}${readOnly}
    <div class="row-actions no-print">
      <a class="btn small" href="/app/calls/${call.id}/report?print=1">View / print report</a>
      <a class="btn small" href="/app/calls/${call.id}">Back to job</a>
    </div>
  </section>`;
  return layout({ title: 'Job report', user: print ? null : user, sub: print ? null : sub, company, flash, body, print });
}

// --- Invoice -----------------------------------------------------------------

function invoicePage({ user, sub, company, settings, rootCall, inv, print, payUrl, recipientEmail, canManage, resendConfigured, profile }) {
  const paid = rootCall.payment_status === 'paid';
  let paymentBlock = '';
  if (paid) {
    paymentBlock = paidStamp(rootCall);
  } else if (!print) {
    const emailForm = canManage ? (recipientEmail
      ? `<form method="post" action="/app/calls/${rootCall.id}/email-invoice" class="inline">
           <button class="btn blue" type="submit">✉ Email invoice to ${esc(recipientEmail)}</button></form>
         ${resendConfigured ? '' : '<p class="muted">Email sending is not configured on the server yet (needs RESEND_API_KEY) — sending will show a notice until it is.</p>'}`
      : `<form method="post" action="/app/calls/${rootCall.id}/email-invoice" class="row-actions">
           <input type="email" name="customer_email" placeholder="Customer email" required style="max-width:280px">
           <button class="btn blue" type="submit">✉ Save email &amp; send invoice</button></form>`) : '';
    const markPaidForm = canManage ? `
      <form method="post" action="/app/calls/${rootCall.id}/mark-paid" class="mark-paid">
        <fieldset><legend>Mark as paid (cash / check / Venmo / PayPal)</legend>
          <div class="grid3">
            <label>Method <select name="method">
              <option>Cash</option><option>Check</option><option>Venmo</option><option>PayPal</option><option>Other</option>
            </select></label>
            <label>Reference (e.g. check #) <input name="reference"></label>
            <label>Date <input type="date" name="paid_date" value="${isoDate(new Date())}"></label>
          </div>
          <button class="btn green" type="submit">✓ Mark as paid</button>
        </fieldset>
      </form>` : '';
    paymentBlock = `
    <div class="no-print payment-box">
      <p><strong>Status:</strong> Unpaid</p>
      ${payUrl ? `<p>Online pay link: <a href="${payUrl}">${esc(payUrl)}</a><br>
      <span class="muted">Share it with the customer — they pay by card and the money goes to your connected Stripe account.</span></p>` : ''}
      <div class="row-actions">${emailForm}</div>
      ${markPaidForm}
    </div>`;
  } else {
    paymentBlock = '<p><strong>Status:</strong> Unpaid</p>';
  }
  const body = `
  <section class="invoice">
    <div class="inv-head">
      <div><img class="logo-img" src="/logo-mark.png" alt="Rise One Man Show"><strong>RISE ONE MAN SHOW</strong></div>
      <div><h2>INVOICE</h2><p>${esc(company.name)}</p></div>
    </div>
    ${profileBlock(profile)}
    <p><strong>Bill to:</strong> ${esc(rootCall.customer_name)}<br>${esc(rootCall.address || '')}</p>
    <p><strong>Job:</strong> ${esc(rootCall.description || '')} · ${rootCall.completed_at ? isoDate(rootCall.completed_at) : ''}</p>
    <table class="inv-table">
      <tr><th>Description</th><th class="r">Amount</th></tr>
      <tr><td>Labor — ${inv.hours.toFixed(2)} hrs × ${money(settings.hourly_rate_cents)}/hr</td><td class="r">${money(inv.laborCents)}</td></tr>
      ${inv.partLines.map((l) => `<tr><td>Part: ${esc(l.description)} — ${l.qty} × ${money(l.costCents)}${inv.multiplierApplied ? ' (× multiplier)' : ''}</td><td class="r">${money(l.billedCents)}</td></tr>`).join('')}
      <tr><td>Subtotal</td><td class="r">${money(inv.subtotalCents)}</td></tr>
      <tr><td>Tax (${esc(settings.tax_percent)}%)</td><td class="r">${money(inv.taxCents)}</td></tr>
      <tr class="total"><td>Total due</td><td class="r">${money(inv.totalCents)}</td></tr>
    </table>
    ${inv.multiplierApplied ? '<p class="muted">Parts billed at a markup over cost (parts multiplier applied).</p>' : ''}
    ${invoiceEmailStamp(rootCall)}
    ${paymentBlock}
    <div class="no-print row-actions"><a class="btn small" href="/app/completed">Back to completed</a></div>
  </section>`;
  return layout({ title: 'Invoice', user: print ? null : user, sub: print ? null : sub, company, body, print });
}

// --- Public invoice pay page (/pay/:token, no login) -------------------------

function payPage({ company, rootCall, inv, settings, state, testMode, justPaid, flash, profile }) {
  let action = '';
  if (state === 'paid') {
    action = `${justPaid ? '<div class="flash ok">Payment received — thank you!</div>' : ''}${paidStamp(rootCall)}`;
  } else if (state === 'pay') {
    action = justPaid
      ? '<div class="flash ok">Payment received — it can take a moment for the status to update here. You can close this page.</div>'
      : (testMode
        ? `<form method="post" action="/pay/${esc(rootCall.pay_token)}/simulate">
             <button class="btn primary wide big" type="submit">Pay ${money(inv.totalCents)} (TEST MODE — simulated)</button></form>
           <p class="muted">TEST MODE: no real card is charged; this simulates a successful card payment.</p>`
        : `<form method="post" action="/pay/${esc(rootCall.pay_token)}/checkout">
             <button class="btn primary wide big" type="submit">Pay ${money(inv.totalCents)}</button></form>
           <p class="muted">Secure card payment processed by Stripe. The money goes directly to ${esc(company.name)}.</p>`);
  } else {
    action = `<p><strong>Online payment isn't available for this invoice yet.</strong><br>
      Please contact ${esc(company.name)}${rootCall.phone ? ' at ' + esc(rootCall.phone) : ''} to arrange payment.</p>`;
  }
  const body = `
  <section class="invoice">
    <div class="inv-head">
      <div><img class="logo-img" src="/logo-mark.png" alt="Rise One Man Show"><strong>RISE ONE MAN SHOW</strong></div>
      <div><h2>INVOICE</h2><p>${esc(company.name)}</p></div>
    </div>
    ${profileBlock(profile)}
    <p><strong>Bill to:</strong> ${esc(rootCall.customer_name)}<br>${esc(rootCall.address || '')}</p>
    <p><strong>Job:</strong> ${esc(rootCall.description || '')} · ${rootCall.completed_at ? isoDate(rootCall.completed_at) : ''}</p>
    <table class="inv-table">
      <tr><th>Description</th><th class="r">Amount</th></tr>
      <tr><td>Labor — ${inv.hours.toFixed(2)} hrs × ${money(settings.hourly_rate_cents)}/hr</td><td class="r">${money(inv.laborCents)}</td></tr>
      ${inv.partLines.map((l) => `<tr><td>Part: ${esc(l.description)} — ${l.qty} × ${money(l.costCents)}${inv.multiplierApplied ? ' (× multiplier)' : ''}</td><td class="r">${money(l.billedCents)}</td></tr>`).join('')}
      <tr><td>Subtotal</td><td class="r">${money(inv.subtotalCents)}</td></tr>
      <tr><td>Tax (${esc(settings.tax_percent)}%)</td><td class="r">${money(inv.taxCents)}</td></tr>
      <tr class="total"><td>Total due</td><td class="r">${money(inv.totalCents)}</td></tr>
    </table>
    ${action}
    <p class="muted" style="text-align:center;margin-top:18px">Powered by Rise One Man Show</p>
  </section>`;
  return layout({ title: 'Pay invoice', flash, body });
}

// --- Completed / Customers ---------------------------------------------------

function completedPage({ user, sub, company, flash, rows }) {
  const body = `<h2>Completed</h2>` + (rows.length
    ? rows.map(({ call, hasInvoice, paid, payMethod }) => `
      <div class="card call-card">
        <div class="call-head"><strong>${esc(call.customer_name)}</strong> ${statusPill(call)}${paid ? ` <span class="pill paid">✓ Paid${payMethod ? ' · ' + esc(payMethodLabel(payMethod)) : ''}</span>` : ''}</div>
        <div class="call-desc">${esc(call.description || '')}</div>
        <div class="muted">👤 ${esc(call.assignee_name || 'Unassigned')} · Completed ${call.completed_at ? new Date(call.completed_at).toLocaleDateString() : ''}</div>
        <div class="row-actions spread">
          <a class="btn green" href="/app/calls/${call.id}/report">📋 Report</a>
          ${hasInvoice ? `<a class="btn blue" href="/app/calls/${call.id}/invoice">🧾 Invoice</a>` : '<span class="muted">No invoice (follow-up chain)</span>'}
        </div>
        <div class="row-actions">
          <form method="post" action="/app/calls/${call.id}/back-to-bucket" class="inline"><button class="btn small">Back to bucket</button></form>
          <form method="post" action="/app/calls/${call.id}/delete" class="inline" onsubmit="return confirm('Delete this call?')"><button class="btn small danger">Delete</button></form>
        </div>
      </div>`).join('')
    : '<p class="muted">No completed calls yet.</p>');
  return layout({ title: 'Completed', user, sub, company, flash, body });
}

function customerEmailBlock({ name, email, from, canEdit }) {
  const action = `/app/customers/${encodeURIComponent(name)}/email`;
  if (!canEdit) {
    return email ? `<div>✉ <a href="mailto:${esc(email)}">${esc(email)}</a></div>` : '<div class="muted">✉ No email on file</div>';
  }
  return `<form method="post" action="${action}" class="row-actions">
    <label style="flex:1;min-width:220px">Customer email
      <input type="email" name="email" value="${esc(email || '')}" placeholder="customer@example.com">
    </label>
    <input type="hidden" name="from" value="${esc(from)}">
    <button class="btn small" type="submit">Save email</button>
  </form>`;
}

function customersPage({ user, sub, company, flash, customers, q, canEditCustomerEmail }) {
  const body = `
  <h2>Customers</h2>
  <form method="get" action="/app/customers" class="row-actions">
    <input name="q" placeholder="Search name, address, phone, email…" value="${esc(q || '')}">
    <button class="btn small" type="submit">Search</button>
  </form>` + (customers.length
    ? customers.map((c) => `
      <div class="card">
        <div class="call-head"><strong>${esc(c.customer_name)}</strong>
          <span class="muted">${c.call_count} call${c.call_count === 1 ? '' : 's'}</span></div>
        <div>${esc(c.address || '')}</div>
        <div class="muted">${esc(c.phone || '')}</div>
        ${customerEmailBlock({ name: c.customer_name, email: c.email, from: 'list', canEdit: canEditCustomerEmail })}
        <div class="row-actions">
          <a class="btn small" href="/app/customers/${encodeURIComponent(c.customer_name)}">Site history</a>
          <a class="btn small teal" href="/app/calls/new?customer=${encodeURIComponent(c.customer_name)}">+ New call</a>
        </div>
      </div>`).join('')
    : '<p class="muted">No customers yet.</p>');
  return layout({ title: 'Customers', user, sub, company, flash, body });
}

function customerDetailPage({ user, sub, company, flash, name, calls, customer, canEditCustomerEmail }) {
  const body = `<h2>${esc(name)}</h2>
  <section class="card">
    <h3>Customer contact</h3>
    ${customerEmailBlock({ name, email: customer ? customer.email : '', from: 'detail', canEdit: canEditCustomerEmail })}
  </section>
  <div class="row-actions"><a class="btn teal" href="/app/calls/new?customer=${encodeURIComponent(name)}">+ New call for this customer</a></div>` +
    calls.map((c) => callCard(c)).join('');
  return layout({ title: name, user, sub, company, flash, body });
}

// --- Log & Report --------------------------------------------------------------

function logPage({ user, sub, company, flash, punches, trips, gas, maint, totals, periodLabel, periods, selectedPeriod }) {
  const hrs = (p) => (p.clock_out ? ((new Date(p.clock_out) - new Date(p.clock_in)) / 3600000).toFixed(2) : 'open');
  const body = `
  <h2>Weekly Log &amp; Report</h2>
  <form method="get" action="/app/log" class="row-actions">
    <select name="period">${periods.map((p, i) => `<option value="${i}" ${i === selectedPeriod ? 'selected' : ''}>${esc(p.label)}</option>`).join('')}</select>
    <button class="btn small" type="submit">View</button>
    <button class="btn small" type="button" onclick="window.print()">Print report</button>
    <a class="btn small" href="/app/log.csv?period=${selectedPeriod}">Export CSV</a>
  </form>
  <section class="card"><h3>${esc(periodLabel)} totals</h3>
    <p>Hours worked: <strong>${totals.hours.toFixed(2)}</strong> · Miles: <strong>${Number(totals.miles).toFixed(1)}</strong>
       · Gas: <strong>${money(totals.gasCents)}</strong> · Maintenance: <strong>${money(totals.maintCents)}</strong></p>
    ${totals.byJob.length ? `<h4>By job</h4>` + totals.byJob.map((j) => `<div class="line">${esc(j.job)} — ${j.hours.toFixed(2)} hrs · ${Number(j.miles).toFixed(1)} mi</div>`).join('') : ''}
    <p class="muted">Monthly: ${totals.monthHours.toFixed(2)} hrs · ${Number(totals.monthMiles).toFixed(1)} mi &nbsp;|&nbsp;
       Quarter (settings dates): ${totals.quarterHours.toFixed(2)} hrs · ${Number(totals.quarterMiles).toFixed(1)} mi</p>
  </section>
  <section class="card"><h3>Shifts</h3>
    ${punches.map((p) => `<div class="line">${isoDate(p.clock_in)} — ${esc(p.job_label || 'Shift')} · ${hrs(p)} hrs
      <form method="post" action="/app/punches/${p.id}/delete" class="inline"><button class="link danger">delete</button></form></div>`).join('') || '<p class="muted">No shifts in this period.</p>'}
    <details><summary>Add missed time</summary>
      <form method="post" action="/app/punches">
        <label>Date <input type="date" name="date" value="${isoDate(new Date())}"></label>
        <label>Job / label <input name="job_label"></label>
        <label>Start <input type="time" name="start" value="08:30"></label>
        <label>End <input type="time" name="end" value="16:30"></label>
        <label class="check"><input type="checkbox" name="pto" value="1"> PTO (8 hrs, no clock times)</label>
        <button class="btn small primary" type="submit">Add</button>
      </form></details>
  </section>
  <section class="card"><h3>Trips</h3>
    ${trips.map((t) => `<div class="line">${isoDate(t.started_at)} — ${Number(t.miles).toFixed(1)} mi ${t.call_id ? '(job #' + t.call_id + ')' : ''} ${esc(t.note || '')}</div>`).join('') || '<p class="muted">No trips in this period.</p>'}
    <details><summary>Add miles by hand</summary>
      <form method="post" action="/app/trips">
        <label>Date <input type="date" name="date" value="${isoDate(new Date())}"></label>
        <label>Miles <input name="miles" inputmode="decimal" required></label>
        <label>Note <input name="note"></label>
        <button class="btn small primary" type="submit">Add</button>
      </form></details>
  </section>
  <section class="card"><h3>Receipts in period</h3>
    ${gas.map((g) => `<div class="line">⛽ ${isoDate(g.date)} — ${money(g.amount_cents)} ${g.receipt_photo ? `<br><img class="receipt" src="${g.receipt_photo}">` : ''}</div>`).join('')}
    ${maint.map((m) => `<div class="line">🔧 ${isoDate(m.date)} — ${money(m.amount_cents)} ${esc(m.work_done || '')} ${m.receipt_photo ? `<br><img class="receipt" src="${m.receipt_photo}">` : ''}</div>`).join('')}
  </section>`;
  return layout({ title: 'Log & Report', user, sub, company, flash, body });
}

// --- Settings / Users -----------------------------------------------------------

function settingsPage({ user, sub, company, flash, s }) {
  let connectSection = '';
  if (user.role === 'owner') {
    let inner = '';
    if (billing.TEST_MODE) {
      inner = s.stripe_charges_enabled
        ? `<p>✓ <strong>Connected (simulated).</strong> Invoice pay links show a simulated card payment — no real charges are possible in TEST MODE.</p>`
        : `<p class="muted">TEST MODE is on (no platform Stripe keys), so Connect can't go live — simulate it to try the invoice pay-link flow end to end.</p>
           <form method="post" action="/app/settings/connect/simulate"><button class="btn teal" type="submit">Simulate Connect setup</button></form>`;
    } else if (!s.stripe_account_id) {
      inner = `<p class="muted">Connect your Stripe account so customers can pay invoices by card from the pay link. The money settles directly to your Stripe account — it never passes through Rise One Man Show.</p>
        <form method="post" action="/app/settings/connect"><button class="btn teal" type="submit">Connect payments with Stripe</button></form>`;
    } else if (!s.stripe_charges_enabled) {
      inner = `<p>⚠️ <strong>Onboarding isn't finished</strong> — card payments stay off until Stripe enables charges on your account.</p>
        <div class="row-actions">
          <form method="post" action="/app/settings/connect" class="inline"><button class="btn teal" type="submit">Continue setup</button></form>
          <a class="btn" href="/app/settings/connect/return">Refresh status</a>
        </div>`;
    } else {
      inner = `<p>✓ <strong>Connected.</strong> Customers can pay invoices by card from the pay link; payments settle to your Stripe account.</p>
        <div class="row-actions"><a class="btn" href="/app/settings/connect/return">Refresh status</a></div>`;
    }
    connectSection = `<section class="card"><h2>Invoice payments</h2>${inner}</section>`;
  }
  const body = `
  <section class="card"><h2>Settings</h2>
    <form method="post" action="/app/settings">
      <fieldset><legend>Company profile — shown on invoices &amp; proposals</legend>
        <label>Company name (blank = ${esc(company.name)}) <input name="profile_display_name" value="${esc(s.profile_display_name || '')}" placeholder="${esc(company.name)}"></label>
        <label>Address <input name="profile_address" value="${esc(s.profile_address || '')}"></label>
        <label>Phone <input name="profile_phone" value="${esc(s.profile_phone || '')}"></label>
        <label>Contact email <input type="email" name="profile_email" value="${esc(s.profile_email || '')}"></label>
        <label>Logo
          <input type="file" accept="image/*" data-photo-input="logo_data_url">
        </label>
        <input type="hidden" name="logo_data_url">
        <div class="thumb-row">${s.logo_data_url ? `<img class="thumb" src="${esc(s.logo_data_url)}" alt="Current logo">` : '<span class="muted">No logo uploaded yet — invoices and proposals work fine without one.</span>'}</div>
        ${s.logo_data_url ? '<label class="check"><input type="checkbox" name="remove_logo" value="1"> Remove the current logo</label>' : ''}
        <p class="muted">PNG, JPG, GIF or WebP, up to 5 MB. The image is resized on upload.</p>
      </fieldset>
      <fieldset><legend>Invoicing</legend>
        <label>Hourly rate ($) <input name="hourly_rate" inputmode="decimal" value="${(s.hourly_rate_cents / 100).toFixed(2)}"></label>
        <label>Tax % <input name="tax_percent" inputmode="decimal" value="${esc(s.tax_percent)}"></label>
        <label>Parts cost multiplier (1 = bill at cost) <input name="parts_multiplier" inputmode="decimal" value="${esc(s.parts_multiplier)}"></label>
      </fieldset>
      <fieldset><legend>Reminders &amp; periods</legend>
        <label>Clock-in reminder <input type="time" name="reminder_in" value="${esc(s.reminder_in)}"></label>
        <label>Clock-out reminder <input type="time" name="reminder_out" value="${esc(s.reminder_out)}"></label>
        <label>Pay period anchor (a Sunday) <input type="date" name="pay_anchor" value="${isoDate(s.pay_anchor)}"></label>
        <label>Pay cycle days <input type="number" name="pay_cycle_days" value="${esc(s.pay_cycle_days)}"></label>
        <label>Quarter start <input type="date" name="quarter_start" value="${isoDate(s.quarter_start)}"></label>
        <label>Quarter end <input type="date" name="quarter_end" value="${isoDate(s.quarter_end)}"></label>
      </fieldset>
      <button class="btn primary wide" type="submit">Save settings</button>
    </form>
  </section>
  ${connectSection}`;
  return layout({ title: 'Settings', user, sub, company, flash, body });
}

function usersPage({ user, sub, company, flash, users, tier, seatUsed }) {
  const t = tier || billing.tiers.tierById(company.plan_tier);
  const used = seatUsed !== undefined ? seatUsed : users.filter((u) => u.active).length;
  const seatsLine = sub && sub.status === 'free'
    ? `<p>Seats: <strong>${used} used</strong> — unlimited seats (free access).</p>`
    : `<p>Seats: <strong>${used} of ${t.seats} used</strong> on the ${esc(t.label)} plan (${money(t.monthlyCents)}/month).${used >= t.seats ? ' <strong>Seat limit reached</strong> — an owner can upgrade the plan on the <a href="/app/billing">Billing page</a> to add more users.' : ''}</p>`;
  const body = `
  <section class="card"><h2>Users — ${esc(company.name)}</h2>
    ${seatsLine}
    ${users.map((u) => `<div class="line"><strong>${esc(u.name)}</strong> · ${esc(u.email)} · <span class="tag">${esc(u.role)}</span> ${u.active ? '' : '<span class="tag warn">deactivated</span>'}
      ${u.id !== user.id ? `<form method="post" action="/app/users/${u.id}/toggle" class="inline"><button class="link">${u.active ? 'Deactivate' : 'Reactivate'}</button></form>
      <form method="post" action="/app/users/${u.id}/reset" class="inline"><input name="password" placeholder="New password" minlength="8" required> <button class="link">Reset password</button></form>` : ''}</div>`).join('')}
    <h3>Add user</h3>
    <form method="post" action="/app/users">
      <label>Name <input name="name" required></label>
      <label>Email <input type="email" name="email" required></label>
      <label>Password <input type="password" name="password" required minlength="8"></label>
      <label>Role <select name="role">
        <option value="tech">Tech — runs jobs</option>
        <option value="admin">Admin — everything except billing</option>
        <option value="owner">Owner — everything incl. billing</option>
      </select></label>
      <button class="btn primary" type="submit">Add user</button>
    </form>
    <p class="muted">Invite flow in v1: create the account here and share the login with your teammate.</p>
  </section>`;
  return layout({ title: 'Users', user, sub, company, flash, body });
}

// --- Price book ---------------------------------------------------------------------

function priceBookPage({ user, sub, company, flash, items, query, editId }) {
  const qParam = query ? '&q=' + encodeURIComponent(query) : '';
  const cancelHref = '/app/price-book' + (query ? '?q=' + encodeURIComponent(query) : '');
  const body = `
  <section class="card"><h2>Price Book — ${esc(company.name)}</h2>
    <p class="muted">Parts your company saves once and reuses on job reports. Pick one on a report and its description and cost fill in automatically — the invoice still applies your parts multiplier, exactly like a hand-typed part.</p>
    <form method="get" action="/app/price-book" class="row-actions">
      <input name="q" placeholder="Search name, part number, description" value="${esc(query || '')}" style="flex:1">
      <button class="btn small" type="submit">Search</button>
      ${query ? '<a class="btn small" href="/app/price-book">Clear</a>' : ''}
    </form>
    <h3>Add a part</h3>
    <form method="post" action="/app/price-book">
      <div class="grid3">
        <label>Name <input name="name" required></label>
        <label>Part number <input name="part_number" placeholder="Optional"></label>
        <label>Cost $ <input name="cost" inputmode="decimal" placeholder="0.00" required></label>
      </div>
      <label>Description <input name="description" placeholder="Optional — shows on the invoice line"></label>
      <button class="btn primary" type="submit">Add part</button>
    </form>
    <h3>Saved parts (${items.length})</h3>
    ${items.length ? items.map((p) => (editId === p.id ? `
    <div class="part-edit">
      <form method="post" action="/app/price-book/${p.id}/edit">
        <label>Name <input name="name" value="${esc(p.name)}" required></label>
        <div class="grid2">
          <label>Part number <input name="part_number" value="${esc(p.part_number || '')}" placeholder="Part #"></label>
          <label>Cost $ <input name="cost" inputmode="decimal" value="${(Number(p.cost_cents) / 100).toFixed(2)}"></label>
        </div>
        <label>Description <input name="description" value="${esc(p.description || '')}" placeholder="Description"></label>
        <div class="row-actions">
          <button class="btn small" type="submit">Save</button>
          <a class="btn small" href="${cancelHref}">Cancel</a>
          <button class="btn small danger" type="submit" formaction="/app/price-book/${p.id}/delete" formnovalidate onclick="return confirm('Remove this part from the price book?')">Delete</button>
        </div>
      </form>
    </div>` : `
    <div class="line">
      <div class="part-row">
        <div><strong>${esc(p.name)}</strong>${p.part_number ? ` <span class="muted">· ${esc(p.part_number)}</span>` : ''}</div>
        <div class="part-row-right"><strong>${money(p.cost_cents)}</strong> <a class="btn small" href="/app/price-book?edit=${p.id}${qParam}">Edit</a></div>
      </div>
      ${p.description ? `<div class="muted">${esc(p.description)}</div>` : ''}
    </div>`)).join('') : '<p class="muted">No parts saved yet — add your first one above.</p>'}
  </section>`;
  return layout({ title: 'Price Book', user, sub, company, flash, body });
}

// --- Billing ----------------------------------------------------------------------

function billingPage({ user, sub, company, flash, events, checkoutState, tier, seatUsed }) {
  const t = tier || billing.tiers.tierById(company.plan_tier);
  const hasCard = !!sub.payment_last4;
  const isFree = sub.status === 'free';
  const otherTiers = billing.tiers.TIERS.filter((x) => x.id !== t.id);
  const planSwitch = isFree ? '' : `
    <h3>Switch plan</h3>
    <p class="muted">Upgrades and downgrades take effect immediately and are prorated by Stripe. You cannot switch to a plan with fewer seats than your current active user count — remove users first.</p>
    ${otherTiers.map((x) => `<form method="post" action="/app/billing/plan-change" class="row-actions">
      <span style="flex:1"><strong>${esc(x.label)}</strong> — ${money(x.monthlyCents)}/month (${x.seats === 1 ? '1 user' : `up to ${x.seats} users`}, ${money(Math.round(x.monthlyCents / x.seats))} per user)</span>
      <input type="hidden" name="plan_tier" value="${esc(x.id)}">
      <button class="btn small" type="submit">Switch to ${esc(x.label)}</button>
    </form>`).join('')}`;
  let actions = '';
  if (isFree) {
    actions = `
      <div class="card inner"><h3>Free access</h3>
      <p>Your company has <strong>free unlimited access</strong>, granted by the platform admin — no charges, unlimited users, never expires. If this ever changes, the billing options will reappear here.</p></div>`;
  } else if (!billing.TEST_MODE) {
    actions = `
      <form method="post" action="/app/billing/checkout"><button class="btn primary wide" type="submit">
        ${sub.status === 'active' ? 'Update subscription / payment method' : 'Add payment method & start subscription'}</button></form>
      ${sub.stripe_customer_id ? '<form method="post" action="/app/billing/portal"><button class="btn wide" type="submit">Open Stripe billing portal</button></form>' : ''}
      <p class="muted">Payments are processed by Stripe. Cards are never stored on this server.</p>`;
  } else {
    actions = `
      <div class="card inner"><h3>TEST MODE — simulated payment method</h3>
      ${hasCard ? `<p>On file: <strong>${esc(sub.payment_brand || 'Card')} •••• ${esc(sub.payment_last4)}</strong></p>` : '<p class="muted">No payment method on file.</p>'}
      <form method="post" action="/app/billing/test-card">
        <label>Test card number <input name="card_number" value="4242 4242 4242 4242"></label>
        <button class="btn primary" type="submit">${hasCard ? 'Replace test card' : 'Add test payment method'}</button>
      </form>
      <div class="row-actions">
        <form method="post" action="/app/billing/simulate-fail" class="inline"><button class="btn small">Simulate failed payment</button></form>
        <form method="post" action="/app/billing/simulate-retry" class="inline"><button class="btn small">Simulate successful retry</button></form>
      </div>
      <p class="muted">Test mode mirrors the live lifecycle: trial converts on day 8 with a card on file, locks without one, and failed payments go past due. Paste real Stripe keys into the server environment to go live — no code changes.</p></div>`;
  }
  const body = `
  <section class="card"><h2>Billing</h2>
    ${checkoutState === 'success' ? '<div class="flash ok">Checkout complete — thank you!</div>' : ''}
    ${checkoutState === 'cancel' ? '<div class="flash">Checkout canceled — no changes made.</div>' : ''}
    <table class="kv">
      <tr><td>Plan</td><td>${isFree ? '<strong>Free access</strong> — unlimited users, never expires, no charge' : `<strong>${esc(t.label)}</strong> — ${money(t.monthlyCents)}/month (${t.seats === 1 ? '1 user' : `up to ${t.seats} users`}) · Seats used: <strong>${seatUsed !== undefined ? seatUsed : '—'} of ${t.seats}</strong>`}</td></tr>
      <tr><td>Status</td><td><strong>${isFree ? 'Free access' : esc(sub.status)}</strong></td></tr>
      <tr><td>Trial</td><td>${isFree ? 'Not applicable — free access never expires.' : `${isoDate(sub.trial_start)} → ${isoDate(sub.trial_end)}${sub.status === 'trialing' ? ` (${daysLeft(sub.trial_end)} days left)` : ''}`}</td></tr>
      ${sub.current_period_end ? `<tr><td>Current period ends</td><td>${isoDate(sub.current_period_end)}</td></tr>` : ''}
      <tr><td>Payment method</td><td>${hasCard ? `${esc(sub.payment_brand || 'Card')} •••• ${esc(sub.payment_last4)}` : 'None on file'}</td></tr>
    </table>
    ${actions}
    ${planSwitch}
    <h3>Billing history</h3>
    ${events.length ? events.map((e) => `<div class="line">${new Date(e.created_at).toLocaleString()} — ${esc(e.type)}${e.detail ? ': ' + esc(e.detail) : ''}</div>`).join('') : '<p class="muted">No billing events yet.</p>'}
  </section>`;
  return layout({ title: 'Billing', user, sub, company, flash, body });
}

// --- Platform admin ------------------------------------------------------------------

function platformPage({ user, flash, companies, totals, demoId }) {
  const body = `
  <h2>Platform admin</h2>
  <section class="card">
    <p>Companies: <strong>${totals.companies}</strong> · Trialing: <strong>${totals.trialing}</strong> ·
       Active: <strong>${totals.active}</strong> · Free: <strong>${totals.free || 0}</strong> · Estimated MRR: <strong>${money(totals.mrrCents || 0)}</strong></p>
    ${totals.breakdown ? `<p class="muted">By plan (trialing + active): ${totals.breakdown.map((b) => `${esc(b.tier.label)}: <strong>${b.count}</strong>`).join(' · ')}</p>` : ''}
  </section>
  ${companies.map((c) => `
  <section class="card">
    <div class="call-head"><strong>${esc(c.name)}</strong> ${c.id === demoId ? '<span class="tag">DEMO</span>' : ''}
      <span class="tag">${esc(c.sub_status || 'no subscription')}</span></div>
    <div class="muted">Signed up ${new Date(c.created_at).toLocaleDateString()} · ${c.user_count} user(s)${c.sub_status === 'free' ? ' · Free access (unlimited)' : (c.trial_end ? ' · Trial ends ' + isoDate(c.trial_end) : '')}</div>
    <div class="row-actions">
      ${c.sub_status === 'free'
        ? `<form method="post" action="/platform/companies/${c.id}/remove-free" class="inline" onsubmit="return confirm('Remove free access? This company goes back to its previous billing status.')"><button class="btn small">Remove free access</button></form>`
        : `<form method="post" action="/platform/companies/${c.id}/extend-trial" class="inline"><button class="btn small">Extend trial +7 days</button></form>
      <form method="post" action="/platform/companies/${c.id}/cancel" class="inline" onsubmit="return confirm('Cancel this subscription?')"><button class="btn small danger">Cancel subscription</button></form>
      <form method="post" action="/platform/companies/${c.id}/make-free" class="inline" onsubmit="return confirm('Give this company free unlimited access? No charges, unlimited users, never expires.')"><button class="btn small">Make free (unlimited)</button></form>`}
      ${c.id === demoId ? `<form method="post" action="/platform/companies/${c.id}/delete" class="inline" onsubmit="return confirm('Remove the demo company and all its data?')"><button class="btn small danger">Remove demo</button></form>` : ''}
    </div>
  </section>`).join('')}`;
  return layout({ title: 'Platform admin', user, flash, body });
}

module.exports = {
  layout, esc, landingPage, loginPage, signupPage, schedulePage, callFormPage,
  statusPill, callCard, jobPage, reportPage, invoicePage, completedPage,
  customersPage, customerDetailPage, logPage, settingsPage, usersPage,
  billingPage, platformPage, payPage, profileBlock, proposalStatusPill, priceBookPage,
  signatureBlock, proposalFormPage, proposalDetailPage, proposalPage, proposalsPage,
};
