'use strict';
// Invoice email via the Resend REST API (no SDK — plain fetch, Node >= 20).
// Configured only when RESEND_API_KEY is set; callers must check configured()
// and degrade gracefully (the app predates email entirely — see README).
const { esc, money, isoDate } = require('./util');

const FROM = 'Rise One Man Show <invoices@riseonemanshow.com>';

function configured() {
  return !!process.env.RESEND_API_KEY;
}

function invoiceEmailBodies({ company, rootCall, inv, settings, payUrl }) {
  const subject = `Invoice from ${company.name} — ${money(inv.totalCents)}`;
  const jobLine = `${rootCall.customer_name} — ${rootCall.description || 'Job'}`;
  const lines = [
    `Labor — ${inv.hours.toFixed(2)} hrs × ${money(settings.hourly_rate_cents)}/hr: ${money(inv.laborCents)}`,
    ...inv.partLines.map((l) => `Part: ${l.description} — ${l.qty} × ${money(l.costCents)}: ${money(l.billedCents)}`),
    `Subtotal: ${money(inv.subtotalCents)}`,
    `Tax (${settings.tax_percent}%): ${money(inv.taxCents)}`,
    `Total due: ${money(inv.totalCents)}`,
  ];
  const text = [
    `Invoice from ${company.name}`,
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
    <div style="border-bottom:3px solid #7c3aed;padding-bottom:10px">
      <strong style="font-size:18px">${esc(company.name)}</strong>
      <div style="color:#555;font-size:13px">Invoice · ${isoDate(new Date())} · via Rise One Man Show</div>
    </div>
    <p><strong>Job:</strong> ${esc(jobLine)}</p>
    <table style="width:100%;border-collapse:collapse" cellpadding="6">${htmlRows}</table>
    <p style="text-align:center;margin:26px 0">
      <a href="${payUrl}" style="display:inline-block;background:#7c3aed;color:#ffffff;font-weight:700;text-decoration:none;padding:13px 30px;border-radius:10px;font-size:16px">Pay ${money(inv.totalCents)}</a>
    </p>
    <p style="color:#555;font-size:13px">Questions about this invoice? Just reply to this email.</p>
  </div></body></html>`;

  return { subject, text, html };
}

async function sendInvoiceEmail({ to, ownerEmail, company, rootCall, inv, settings, payUrl }) {
  if (!configured()) throw new Error('Email is not configured (RESEND_API_KEY is not set).');
  const { subject, text, html } = invoiceEmailBodies({ company, rootCall, inv, settings, payUrl });
  const payload = { from: FROM, to: [to], subject, text, html };
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

module.exports = { configured, sendInvoiceEmail, invoiceEmailBodies };
