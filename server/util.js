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

module.exports = { esc, money, dollarsToCents, haversineMiles, trackMiles, computeInvoice, hoursBetween, daysLeft, mapsUrl, isoDate };
