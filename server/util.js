'use strict';
// Pure helpers (unit-testable, no I/O).

function esc(s) {
  if (s === null || s === undefined) return '';
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function money(cents) {
  const n = Number(cents || 0);
  return '$' + (n / 100).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function dollarsToCents(v) {
  const n = parseFloat(String(v || '0').replace(/[^0-9.\-]/g, ''));
  return Number.isFinite(n) ? Math.round(n * 100) : 0;
}

// Haversine distance in miles between two lat/lng points.
function haversineMiles(lat1, lon1, lat2, lon2) {
  const R = 3958.8;
  const dLat = ((lat2 - lat1) * Math.PI) / 180;
  const dLon = ((lon2 - lon1) * Math.PI) / 180;
  const a =
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos((lat1 * Math.PI) / 180) * Math.cos((lat2 * Math.PI) / 180) *
      Math.sin(dLon / 2) * Math.sin(dLon / 2);
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

// Sum GPS points [{lat,lng}, ...] into total miles.
function trackMiles(points) {
  let total = 0;
  for (let i = 1; i < points.length; i++) {
    total += haversineMiles(points[i - 1].lat, points[i - 1].lng, points[i].lat, points[i].lng);
  }
  return Math.round(total * 100) / 100;
}

// Invoice math for a completed chain.
// hours: total chain hours; parts: [{qty, description, costCents}]
// settings: {hourlyRateCents, taxPercent, partsMultiplier}
// Labor is billed from hours rounded to 2 decimals (matches the on-screen display).
function computeInvoice({ hours, parts, hourlyRateCents, taxPercent, partsMultiplier }) {
  const billedHours = Math.round(Number(hours || 0) * 100) / 100;
  const laborCents = Math.round(billedHours * Number(hourlyRateCents || 0));
  const mult = Number(partsMultiplier || 1);
  const partLines = (parts || []).map((p) => {
    const qty = Number(p.qty || 0);
    const costCents = Number(p.costCents || 0);
    return {
      qty,
      description: p.description || '',
      costCents,
      billedCents: Math.round(qty * costCents * mult),
    };
  });
  const partsCents = partLines.reduce((s, l) => s + l.billedCents, 0);
  const subtotalCents = laborCents + partsCents;
  const taxCents = Math.round(subtotalCents * (Number(taxPercent || 0) / 100));
  return {
    hours: billedHours,
    laborCents,
    partLines,
    partsCents,
    subtotalCents,
    taxCents,
    totalCents: subtotalCents + taxCents,
    multiplierApplied: mult !== 1,
  };
}

function hoursBetween(startIso, endIso) {
  if (!startIso || !endIso) return 0;
  const ms = new Date(endIso).getTime() - new Date(startIso).getTime();
  return ms > 0 ? ms / 3600000 : 0;
}

function daysLeft(untilIso, now = new Date()) {
  const ms = new Date(untilIso).getTime() - now.getTime();
  return Math.ceil(ms / 86400000);
}

function mapsUrl(address) {
  return 'https://www.google.com/maps/search/?api=1&query=' + encodeURIComponent(address || '');
}

function isoDate(d) {
  return new Date(d).toISOString().slice(0, 10);
}

// --- Report CSV export (bookkeeper / QuickBooks) ------------------------------
// One row per report item, plain numbers (no $ signs or thousands separators)
// so a bookkeeper can map the columns on QuickBooks CSV import. Amounts are
// dollars with two decimals. Labor amount = hours x the company's hourly rate;
// mileage amount is left blank for the bookkeeper's own mileage rate.
function csvCell(v) {
  const s = String(v ?? '');
  return /[",\n\r]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
}

function buildReportCsv({ punches, trips, gas, maint, invoices, hourlyRateCents, callLabels }) {
  const rows = [['Date', 'Type', 'Job', 'Description', 'Hours', 'Miles', 'Amount']];
  for (const p of (punches || [])) {
    if (!p.clock_out) continue;
    const h = hoursBetween(p.clock_in, p.clock_out);
    rows.push([isoDate(p.clock_in), 'Labor', p.job_label || 'Shift', '', h.toFixed(2), '', (h * (hourlyRateCents || 0) / 100).toFixed(2)]);
  }
  for (const t of (trips || [])) {
    rows.push([isoDate(t.started_at), 'Mileage', t.call_id ? (callLabels[t.call_id] || 'Job') : 'Manual miles', t.note || '', '', Number(t.miles || 0).toFixed(1), '']);
  }
  for (const g of (gas || [])) {
    rows.push([isoDate(g.date), 'Gas', '', g.note || '', '', '', (g.amount_cents / 100).toFixed(2)]);
  }
  for (const m of (maint || [])) {
    const desc = [m.work_done, m.shop].filter(Boolean).join(' — ');
    rows.push([isoDate(m.date), 'Maintenance', '', desc || m.note || '', '', '', (m.amount_cents / 100).toFixed(2)]);
  }
  for (const inv of (invoices || [])) {
    rows.push([inv.date, 'Invoice', inv.job, inv.paid ? 'Paid' : 'Unpaid', '', '', (inv.totalCents / 100).toFixed(2)]);
  }
  const body = rows.slice(1).sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
  return [rows[0], ...body].map((r) => r.map(csvCell).join(',')).join('\r\n') + '\r\n';
}

module.exports = { esc, money, dollarsToCents, haversineMiles, trackMiles, computeInvoice, hoursBetween, daysLeft, mapsUrl, isoDate, csvCell, buildReportCsv };
