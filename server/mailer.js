'use strict';
// Invoice email via the Resend REST API (no SDK — plain fetch, Node >= 20).
// Configured only when RESEND_API_KEY is set; callers must check configured()
// and degrade gracefully (the app predates email entirely — see README).
const { esc, money, isoDate, parseImageDataUrl } = require('./util');

const FROM = 'Rise One Man Show <invoices@riseonemanshow.com>';

function configured() {
  return !!process.env.RESEND_API_KEY;
}

// profile: { name, address, phone, email, logoUrl } — the company's
// own branding from Settings -> Company profile. logoUrl is the logo
// data URL stored in the database, inlined straight into the img src;
// every field is optional.
function profileHeaderHtml(profile) {
  if (!profile) return '';
  const contact = [profile.address, profile.phone, profile.email].filter(Boolean).join(' · ');
  // Gmail strips data: images, so a data-URL logo is referenced as an
  // inline CID attachment instead (see logoAttachment, attached by the
  // send functions). A plain URL is used as-is. The dark tile behind the
  // logo keeps a light (e.g. white) logo readable on the white email.
  const logoSrc = profile.logoUrl && profile.logoUrl.startsWith('data:')
    ? 'cid:company-logo'
    : (profile.logoUrl || '');
  return `<div style="border-bottom:3px solid #7c3aed;padding-bottom:10px">
    ${logoSrc ? `<img src="${esc(logoSrc)}" alt="" style="max-height:64px;max-width:220px;display:block;margin-bottom:8px;background:#0b1d33;padding:8px;border-radius:8px">` : ''}
    <strong style="font-size:18px">${esc(profile.name)}</strong>
    ${contact ? `<div style="color:#555;font-size:13px">${esc(contact)}</div>` : ''}
  </div>`;
}

// Inline attachment for the company logo, so it renders in Gmail (which
// strips data: images). Returns null when there is no logo or it is not
// a data URL. The HTML references it as cid:company-logo.
function logoAttachment(profile) {
  const url = profile && profile.logoUrl;
  if (!url || !url.startsWith('data:')) return null;
  const parsed = parseImageDataUrl(url);
  if (!parsed) return null;
  const b64 = url.split(',')[1];
  if (!b64) return null;
  return { filename: `logo.${parsed.ext}`, content: b64, content_id: 'company-logo' };
}

function profileHeaderText(profile) {
  if (!profile) return [];
  const contact = [profile.address, profile.phone, profile.email].filter(Boolean).join(' · ');
  return [profile.name, contact].filter(Boolean);
}

function invoiceEmailBodies({ company, rootCall, inv, settings, payUrl, profile }) {
  const fromName = (profile && profile.name) || company.name;
  const subject = `Invoice from ${fromName} — ${money(inv.totalCents)}`;
  const jobLine = `${rootCall.customer_name} — ${rootCall.description || 'Job'}`;
  const lines = [
    `Labor — ${inv.hours.toFixed(2)} hrs × ${money(settings.hourly_rate_cents)}/hr: ${money(inv.laborCents)}`,
    ...inv.partLines.map((l) => `Part: ${l.description} — ${l.qty} × ${money(l.costCents)}: ${money(l.billedCents)}`),
    `Subtotal: ${money(inv.subtotalCents)}`,
    `Tax (${settings.tax_percent}%): ${money(inv.taxCents)}`,
    `Total due: ${money(inv.totalCents)}`,
  ];
  const text = [
    `Invoice from ${fromName}`,
    ...profileHeaderText(profile),
    '',
    `Job: ${jobLine}`,
    `Date: ${isoDate(new Date())}`,
    '',
    ...lines,
    '',
    `Pay online: ${payUrl}`,
    '',
    'Questions about this invoice? Reply to this email.',
  ].join('\n');

  const htmlRows = [
    `<tr><td>Labor — ${inv.hours.toFixed(2)} hrs × ${money(settings.hourly_rate_cents)}/hr</td><td style="text-align:right">${money(inv.laborCents)}</td></tr>`,
    ...inv.partLines.map((l) => `<tr><td>Part: ${esc(l.description)} — ${l.qty} × ${money(l.costCents)}</td><td style="text-align:right">${money(l.billedCents)}</td></tr>`),
    `<tr><td>Subtotal</td><td style="text-align:right">${money(inv.subtotalCents)}</td></tr>`,
    `<tr><td>Tax (${esc(settings.tax_percent)}%)</td><td style="text-align:right">${money(inv.taxCents)}</td></tr>`,
    `<tr><td><strong>Total due</strong></td><td style="text-align:right"><strong>${money(inv.totalCents)}</strong></td></tr>`,
  ].join('');
  const html = `<!doctype html><html><body style="margin:0;background:#0b1d33;padding:24px 12px;font-family:system-ui,-apple-system,Segoe UI,Roboto,sans-serif">
  <div style="max-width:560px;margin:0 auto;background:#ffffff;color:#111;border-radius:12px;padding:26px">
    ${profileHeaderHtml(profile)}
    <div style="color:#555;font-size:13px;margin-top:8px">Invoice · ${isoDate(new Date())} · via Rise One Man Show</div>
    <p><strong>Job:</strong> ${esc(jobLine)}</p>
    <table style="width:100%;border-collapse:collapse" cellpadding="6">${htmlRows}</table>
    <p style="text-align:center;margin:26px 0">
      <a href="${payUrl}" style="display:inline-block;background:#7c3aed;color:#ffffff;font-weight:700;text-decoration:none;padding:13px 30px;border-radius:10px;font-size:16px">Pay ${money(inv.totalCents)}</a>
    </p>
    <p style="color:#555;font-size:13px">Questions about this invoice? Just reply to this email.</p>
  </div></body></html>`;

  return { subject, text, html };
}

// --- Proposals -----------------------------------------------------------------
// The email mirrors the proposal's display mode: 'total_only' shows just the
// final amount; 'itemized' shows the full line breakdown. Either way the
// customer decides on the proposal page behind the link.
function proposalEmailBodies({ company, call, proposal, totals, proposalUrl, profile }) {
  const fromName = (profile && profile.name) || company.name;
  const subject = `Proposal from ${fromName} — ${money(totals.totalCents)}`;
  const jobLine = `${call.customer_name} — ${call.description || 'Job'}`;
  const itemized = proposal.display_mode !== 'total_only';
  const lines = itemized
    ? [
        ...(totals.laborCents > 0 ? [`Labor — ${totals.laborHours} hrs × ${money(totals.laborRateCents)}/hr: ${money(totals.laborCents)}`] : []),
        ...totals.lines.map((l) => `${l.description} — ${l.qty} × ${money(l.unitCostCents)}${totals.multiplierApplied ? ' (× multiplier)' : ''}: ${money(l.lineCents)}`),
        `Subtotal: ${money(totals.subtotalCents)}`,
        `Tax: ${money(totals.taxCents)}`,
      ]
    : [];
  const text = [
    `Proposal from ${fromName}`,
    ...profileHeaderText(profile),
    '',
    `Job: ${jobLine}`,
    `Date: ${isoDate(new Date())}`,
    '',
    ...(proposal.customer_note ? [`Note from ${fromName}:`, proposal.customer_note, ''] : []),
    ...lines,
    `Total: ${money(totals.totalCents)}`,
    '',
    `Review and approve, or request changes: ${proposalUrl}`,
    '',
    'Questions about this proposal? Reply to this email.',
  ].join('\n');

  const htmlRows = itemized
    ? [
        ...(totals.laborCents > 0 ? [`<tr><td>Labor — ${totals.laborHours} hrs × ${money(totals.laborRateCents)}/hr</td><td style="text-align:right">${money(totals.laborCents)}</td></tr>`] : []),
        ...totals.lines.map((l) => `<tr><td>${esc(l.description)} — ${l.qty} × ${money(l.unitCostCents)}${totals.multiplierApplied ? ' (× multiplier)' : ''}</td><td style="text-align:right">${money(l.lineCents)}</td></tr>`),
        `<tr><td>Subtotal</td><td style="text-align:right">${money(totals.subtotalCents)}</td></tr>`,
        `<tr><td>Tax</td><td style="text-align:right">${money(totals.taxCents)}</td></tr>`,
      ].join('')
    : '';
  const html = `<!doctype html><html><body style="margin:0;background:#0b1d33;padding:24px 12px;font-family:system-ui,-apple-system,Segoe UI,Roboto,sans-serif">
  <div style="max-width:560px;margin:0 auto;background:#ffffff;color:#111;border-radius:12px;padding:26px">
    ${profileHeaderHtml(profile)}
    <div style="color:#555;font-size:13px;margin-top:8px">Proposal · ${isoDate(new Date())} · via Rise One Man Show</div>
    <p><strong>Job:</strong> ${esc(jobLine)}</p>
    ${proposal.customer_note ? `<p>${esc(proposal.customer_note)}</p>` : ''}
    ${itemized ? `<table style="width:100%;border-collapse:collapse" cellpadding="6">${htmlRows}</table>` : ''}
    <p style="font-size:18px"><strong>Total: ${money(totals.totalCents)}</strong></p>
    <p style="text-align:center;margin:26px 0">
      <a href="${proposalUrl}" style="display:inline-block;background:#7c3aed;color:#ffffff;font-weight:700;text-decoration:none;padding:13px 30px;border-radius:10px;font-size:16px">Review proposal</a>
    </p>
    <p style="color:#555;font-size:13px">Approve it right on the page (with your signature), or request changes and tell us what to adjust. Questions? Just reply to this email.</p>
  </div></body></html>`;

  return { subject, text, html };
}

async function sendProposalEmail({ to, ownerEmail, company, call, proposal, totals, proposalUrl, profile }) {
  if (!configured()) throw new Error('Email is not configured (RESEND_API_KEY is not set).');
  const { subject, text, html } = proposalEmailBodies({ company, call, proposal, totals, proposalUrl, profile });
  const payload = { from: FROM, to: [to], subject, text, html };
  const logo = logoAttachment(profile);
  if (logo) payload.attachments = [logo];
  if (ownerEmail) payload.reply_to = ownerEmail;
  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${process.env.RESEND_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(payload),
  });
  if (!res.ok) {
    const detail = await res.text().catch(() => '');
    throw new Error(`Resend API error ${res.status}${detail ? ': ' + detail.slice(0, 200) : ''}`);
  }
  return res.json().catch(() => ({}));
}

async function sendInvoiceEmail({ to, ownerEmail, company, rootCall, inv, settings, payUrl, profile }) {
  if (!configured()) throw new Error('Email is not configured (RESEND_API_KEY is not set).');
  const { subject, text, html } = invoiceEmailBodies({ company, rootCall, inv, settings, payUrl, profile });
  const payload = { from: FROM, to: [to], subject, text, html };
  const logo = logoAttachment(profile);
  if (logo) payload.attachments = [logo];
  if (ownerEmail) payload.reply_to = ownerEmail;
  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${process.env.RESEND_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(payload),
  });
  if (!res.ok) {
    const detail = await res.text().catch(() => '');
    throw new Error(`Resend API error ${res.status}${detail ? ': ' + detail.slice(0, 200) : ''}`);
  }
  return res.json().catch(() => ({}));
}

module.exports = { configured, sendInvoiceEmail, invoiceEmailBodies, sendProposalEmail, proposalEmailBodies, logoAttachment };
