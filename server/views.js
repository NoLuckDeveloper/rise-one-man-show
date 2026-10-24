'use strict';
const { esc, money, daysLeft, mapsUrl, isoDate } = require('./util');
const billing = require('./billing');

function flashHtml(flash) {
  if (!flash) return '';
  return `<div class="flash ${flash.kind || ''}">${esc(flash.msg)}</div>`;
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
  if (sub.status === 'trial_ended' || sub.status === 'canceled') {
    return `<div class="banner warn">Subscription ${sub.status === 'canceled' ? 'canceled' : 'trial ended'} — the app is locked to billing.${testTag}</div>`;
  }
  return billing.TEST_MODE ? `<div class="banner subtle">Billing is in TEST MODE — no real charges.${testTag}</div>` : '';
}

function layout({ title, user, sub, company, flash, body, print }) {
  const nav = user
    ? `<nav class="tabs">
        ${user.role === 'platform'
          ? '<a href="/platform">Platform</a>'
          : `<a href="/app">Schedule</a>
             <a href="/app/completed">Completed</a>
             <a href="/app/customers">Customers</a>
             <a href="/app/log">Log &amp; Report</a>
             ${user.role !== 'tech' ? '<a href="/app/users">Users</a>' : ''}
             ${user.role !== 'tech' ? '<a href="/app/settings">Settings</a>' : ''}
             ${user.role === 'owner' ? '<a href="/app/billing">Billing</a>' : ''}
             <a href="/platform">Platform</a>`}
        <form method="post" action="/logout" class="logout"><button type="submit">Log out</button></form>
      </nav>`
    : '';
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)} · Rise One Man Show</title>
<link rel="stylesheet" href="/style.css">
</head><body class="${print ? 'print' : ''}">
<header class="brand">
  <div class="logo">🔧</div>
  <div class="wordmark">RISE <span>ONE MAN SHOW</span></div>
  ${company ? `<div class="company-name">${esc(company.name)}</div>` : ''}
</header>
${nav}
${subBanner(user, sub)}
<main>${flashHtml(flash)}${body}</main>
${print ? '' : '<footer class="site-footer"><a href="/terms.html">Terms of Service</a> · <a href="/privacy.html">Privacy Policy</a></footer>'}
<script src="/app.js"></script>
</body></html>`;
}

function landingPage(flash) {
  const body = `
  <section class="hero">
    <h1>Run the whole job from your phone.</h1>
    <p>New call comes in. Book it. Drive it. Fix it. Invoice it. Field management
       software for solo and small field-service businesses — scheduling, job
       reports, invoicing, mileage and hours in one place.</p>
    <p class="price"><strong>$10.99/month</strong> per company · 7-day free trial · cancel anytime</p>
    <div class="cta-row">
      <a class="btn primary" href="/signup">Start free trial</a>
      <a class="btn" href="/login">Log in</a>
    </div>
  </section>`;
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

function signupPage(flash) {
  const body = `
  <section class="card narrow">
    <h2>Create your company</h2>
    <p class="muted">7-day free trial starts today. $10.99/month per company after that — add a card before the trial ends to keep the app unlocked.</p>
    <form method="post" action="/signup">
      <label>Company name <input name="company_name" required></label>
      <label>Your name <input name="owner_name" required autocomplete="name"></label>
      <label>Email <input type="email" name="email" required autocomplete="email"></label>
      <label>Password <input type="password" name="password" required minlength="8" autocomplete="new-password"></label>
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
    ${call.address ? `<div><a href="${mapsUrl(call.address)}" target="_blank" rel="noopener">📍 ${esc(call.address)}</a></div>` : ''}
    ${call.scheduled_date ? `<div class="sched-time">🗓 ${isoDate(call.scheduled_date)}${call.scheduled_time ? ' · ' + esc(call.scheduled_time) : ''}</div>` : ''}
    <div class="row-actions">
      ${showOpen && call.status !== 'completed' ? `<a class="btn small teal" href="/app/calls/${call.id}">Open job</a>` : ''}
      <a class="btn small" href="/app/calls/${call.id}/edit">Edit</a>
      ${call.status === 'completed' ? `<a class="btn small green" href="/app/calls/${call.id}/report">📋 Report</a>` : ''}
    </div>
  </div>`;
}

function schedulePage({ user, sub, company, flash, bucket, byDay, todayGas, todayMaint }) {
  let body = `<div class="page-head"><h2>Schedule</h2>
    <span class="bucket-count">${bucket.length} in the Bucket</span></div>`;

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
  <a class="fab" href="/app/calls/new" title="New call">+</a>`;
  return layout({ title: 'Schedule', user, sub, company, flash, body });
}

function callFormPage({ user, sub, company, flash, call, prefill }) {
  const c = call || prefill || {};
  const editing = !!call;
  const body = `
  <section class="card">
    <h2>${editing ? 'Edit call' : 'New call'}</h2>
    <form method="post" action="${editing ? `/app/calls/${call.id}/edit` : '/app/calls'}">
      <label>Customer name <input name="customer_name" required value="${esc(c.customer_name || '')}"></label>
      <label>Address <input name="address" value="${esc(c.address || '')}"></label>
      <label>Phone <input name="phone" value="${esc(c.phone || '')}"></label>
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

function jobPage({ user, sub, company, flash, call, report, openPunch, openTrip, chainHours, chainMiles, invoiceReady }) {
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
  </section>`;
  return layout({ title: call.customer_name, user, sub, company, flash, body });
}

// --- Job report --------------------------------------------------------------

function reportPage({ user, sub, company, flash, call, report, chainHours, chainMiles, print }) {
  const r = report || {};
  const parts = Array.isArray(r.parts) ? r.parts : [];
  const photos = Array.isArray(r.photos) ? r.photos : [];
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

function invoicePage({ user, sub, company, settings, rootCall, inv, print }) {
  const body = `
  <section class="invoice">
    <div class="inv-head">
      <div><div class="logo">🔧</div><strong>RISE ONE MAN SHOW</strong></div>
      <div><h2>INVOICE</h2><p>${esc(company.name)}</p></div>
    </div>
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
    <div class="no-print row-actions"><a class="btn small" href="/app/completed">Back to completed</a></div>
  </section>`;
  return layout({ title: 'Invoice', user: print ? null : user, sub: print ? null : sub, company, body, print });
}

// --- Completed / Customers ---------------------------------------------------

function completedPage({ user, sub, company, flash, rows }) {
  const body = `<h2>Completed</h2>` + (rows.length
    ? rows.map(({ call, hasInvoice }) => `
      <div class="card call-card">
        <div class="call-head"><strong>${esc(call.customer_name)}</strong> ${statusPill(call)}</div>
        <div class="call-desc">${esc(call.description || '')}</div>
        <div class="muted">Completed ${call.completed_at ? new Date(call.completed_at).toLocaleDateString() : ''}</div>
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

function customersPage({ user, sub, company, flash, customers, q }) {
  const body = `
  <h2>Customers</h2>
  <form method="get" action="/app/customers" class="row-actions">
    <input name="q" placeholder="Search name, address, phone…" value="${esc(q || '')}">
    <button class="btn small" type="submit">Search</button>
  </form>` + (customers.length
    ? customers.map((c) => `
      <div class="card">
        <div class="call-head"><strong>${esc(c.customer_name)}</strong>
          <span class="muted">${c.call_count} call${c.call_count === 1 ? '' : 's'}</span></div>
        <div>${esc(c.address || '')}</div>
        <div class="muted">${esc(c.phone || '')}</div>
        <div class="row-actions">
          <a class="btn small" href="/app/customers/${encodeURIComponent(c.customer_name)}">Site history</a>
          <a class="btn small teal" href="/app/calls/new?customer=${encodeURIComponent(c.customer_name)}">+ New call</a>
        </div>
      </div>`).join('')
    : '<p class="muted">No customers yet.</p>');
  return layout({ title: 'Customers', user, sub, company, flash, body });
}

function customerDetailPage({ user, sub, company, flash, name, calls }) {
  const body = `<h2>${esc(name)}</h2>
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
  const body = `
  <section class="card"><h2>Settings</h2>
    <form method="post" action="/app/settings">
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
  </section>`;
  return layout({ title: 'Settings', user, sub, company, flash, body });
}

function usersPage({ user, sub, company, flash, users }) {
  const body = `
  <section class="card"><h2>Users — ${esc(company.name)}</h2>
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

// --- Billing ----------------------------------------------------------------------

function billingPage({ user, sub, company, flash, events, checkoutState }) {
  const hasCard = !!sub.payment_last4;
  let actions = '';
  if (!billing.TEST_MODE) {
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
      <tr><td>Plan</td><td><strong>$10.99/month</strong> per company (flat, not per user)</td></tr>
      <tr><td>Status</td><td><strong>${esc(sub.status)}</strong></td></tr>
      <tr><td>Trial</td><td>${isoDate(sub.trial_start)} → ${isoDate(sub.trial_end)}${sub.status === 'trialing' ? ` (${daysLeft(sub.trial_end)} days left)` : ''}</td></tr>
      ${sub.current_period_end ? `<tr><td>Current period ends</td><td>${isoDate(sub.current_period_end)}</td></tr>` : ''}
      <tr><td>Payment method</td><td>${hasCard ? `${esc(sub.payment_brand || 'Card')} •••• ${esc(sub.payment_last4)}` : 'None on file'}</td></tr>
    </table>
    ${actions}
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
       Active: <strong>${totals.active}</strong> · Estimated MRR: <strong>${money(totals.active * 1099)}</strong></p>
  </section>
  ${companies.map((c) => `
  <section class="card">
    <div class="call-head"><strong>${esc(c.name)}</strong> ${c.id === demoId ? '<span class="tag">DEMO</span>' : ''}
      <span class="tag">${esc(c.sub_status || 'no subscription')}</span></div>
    <div class="muted">Signed up ${new Date(c.created_at).toLocaleDateString()} · ${c.user_count} user(s)${c.trial_end ? ' · Trial ends ' + isoDate(c.trial_end) : ''}</div>
    <div class="row-actions">
      <form method="post" action="/platform/companies/${c.id}/extend-trial" class="inline"><button class="btn small">Extend trial +7 days</button></form>
      <form method="post" action="/platform/companies/${c.id}/cancel" class="inline" onsubmit="return confirm('Cancel this subscription?')"><button class="btn small danger">Cancel subscription</button></form>
      ${c.id === demoId ? `<form method="post" action="/platform/companies/${c.id}/delete" class="inline" onsubmit="return confirm('Remove the demo company and all its data?')"><button class="btn small danger">Remove demo</button></form>` : ''}
    </div>
  </section>`).join('')}`;
  return layout({ title: 'Platform admin', user, flash, body });
}

module.exports = {
  layout, esc, landingPage, loginPage, signupPage, schedulePage, callFormPage,
  statusPill, callCard, jobPage, reportPage, invoicePage, completedPage,
  customersPage, customerDetailPage, logPage, settingsPage, usersPage,
  billingPage, platformPage,
};
