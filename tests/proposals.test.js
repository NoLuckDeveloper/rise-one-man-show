'use strict';
// Unit tests: proposal math, image data-URL validation (logo uploads and
// the signature pad), and proposal/invoice email bodies (display modes and
// company profile). No database needed: node tests/proposals.test.js
const assert = require('node:assert');
const { computeProposal, parseImageDataUrl } = require('../server/util');
const mailer = require('../server/mailer');
const { signaturePng, blankPng, logoPng, dataUrl } = require('./png-helper');

// --- computeProposal ---------------------------------------------------------
{
  const t = computeProposal({
    items: [
      { description: 'Faucet install', qty: 1, unitCostCents: 15000 },
      { description: 'Supply pipe', qty: 2, unitCostCents: 1250 },
    ],
    taxPercent: 10,
  });
  assert.deepStrictEqual(t.lines.map((l) => l.lineCents), [15000, 2500]);
  assert.strictEqual(t.subtotalCents, 17500);
  assert.strictEqual(t.taxCents, 1750);
  assert.strictEqual(t.totalCents, 19250);
}
{
  const t = computeProposal({ items: [], taxPercent: 8.25 });
  assert.strictEqual(t.subtotalCents, 0);
  assert.strictEqual(t.taxCents, 0);
  assert.strictEqual(t.totalCents, 0);
}
{
  // Fractional qty rounds per line, like invoice parts.
  const t = computeProposal({ items: [{ description: 'Labor-ish', qty: 1.5, unitCostCents: 333 }], taxPercent: 0 });
  assert.strictEqual(t.lines[0].lineCents, 500); // Math.round(1.5 * 333) = 500
  assert.strictEqual(t.totalCents, 500);
}

// --- parseImageDataUrl ---------------------------------------------------------
const sig = signaturePng();
const sigUrl = dataUrl(sig);
const blankUrl = dataUrl(blankPng());
console.log(`signature PNG bytes: ${sig.length}, blank PNG bytes: ${blankPng().length}`);
{
  const parsed = parseImageDataUrl(sigUrl);
  assert.ok(parsed, 'real signature PNG did not parse');
  assert.strictEqual(parsed.mime, 'image/png');
  assert.strictEqual(parsed.ext, 'png');
  assert.ok(parsed.bytes.length > 1000, 'signature PNG unexpectedly small — size floor would reject it');
}
{
  // A blank canvas encodes to a few hundred bytes: it clears format
  // validation but must fail the signature size floor.
  assert.ok(parseImageDataUrl(blankUrl), 'blank PNG should still be a valid image');
  assert.strictEqual(parseImageDataUrl(blankUrl, { minBytes: 1000 }), null, 'blank signature passed the size floor');
  assert.ok(parseImageDataUrl(sigUrl, { minBytes: 1000 }), 'real signature failed the size floor');
}
{
  const logo = parseImageDataUrl(dataUrl(logoPng()));
  assert.ok(logo && logo.ext === 'png', 'logo PNG did not parse');
  assert.strictEqual(parseImageDataUrl(dataUrl(logoPng()), { maxBytes: 10 }), null, 'oversize image passed');
  assert.strictEqual(parseImageDataUrl('not a data url'), null, 'garbage passed');
  assert.strictEqual(parseImageDataUrl('data:text/plain;base64,abcd'), null, 'non-image data URL passed');
  // PNG bytes labeled as JPEG must fail the magic-byte check.
  assert.strictEqual(parseImageDataUrl(sigUrl.replace('image/png', 'image/jpeg')), null, 'mime/magic mismatch passed');
  assert.strictEqual(parseImageDataUrl('data:image/png;base64,!!!!'), null, 'bad base64 passed');
}

// --- Email bodies --------------------------------------------------------------
const company = { name: 'Handyman Co' };
const call = { customer_name: 'Sarah Miller', description: 'Kitchen faucet leaking' };
const settings = { hourly_rate_cents: 10000, tax_percent: 10 };
const profile = { name: 'Handyman Co', address: '12 Main St, Marble Falls, TX', phone: '555-0100', email: 'office@handyman.test', logoUrl: dataUrl(logoPng()) };
const totals = computeProposal({
  items: [
    { description: 'Faucet install', qty: 1, unitCostCents: 15000 },
    { description: 'Supply pipe', qty: 2, unitCostCents: 1250 },
  ],
  taxPercent: 10,
});
{
  const itemized = mailer.proposalEmailBodies({
    company, call,
    proposal: { display_mode: 'itemized', customer_note: 'Two-day job.' },
    totals, proposalUrl: 'https://example.test/proposal/abc', profile,
  });
  assert.ok(itemized.subject.includes('$192.50'), 'itemized subject missing total');
  assert.ok(itemized.html.includes('Faucet install'), 'itemized email hides line items');
  assert.ok(itemized.html.includes('Supply pipe'), 'itemized email hides second line');
  assert.ok(itemized.html.includes('Two-day job.'), 'itemized email hides customer note');
  assert.ok(itemized.html.includes(profile.logoUrl), 'proposal email hides company logo');
  assert.ok(itemized.html.includes('12 Main St'), 'proposal email hides company address');
  assert.ok(itemized.text.includes('Faucet install'), 'itemized text email hides line items');

  const totalOnly = mailer.proposalEmailBodies({
    company, call,
    proposal: { display_mode: 'total_only', customer_note: '' },
    totals, proposalUrl: 'https://example.test/proposal/abc', profile,
  });
  assert.ok(!totalOnly.html.includes('Faucet install'), 'total-only email leaks line items');
  assert.ok(!totalOnly.html.includes('Supply pipe'), 'total-only email leaks line items');
  assert.ok(totalOnly.html.includes('$192.50'), 'total-only email hides the total');
  assert.ok(totalOnly.text.includes('$192.50'), 'total-only text email hides the total');
  assert.ok(!totalOnly.text.includes('Faucet install'), 'total-only text email leaks line items');
}
{
  const inv = {
    hours: 1.5, laborCents: 15000,
    partLines: [{ description: 'Faucet', qty: 1, costCents: 4200, billedCents: 4200 }],
    partsCents: 4200, subtotalCents: 19200, taxCents: 1920, totalCents: 21120, multiplierApplied: false,
  };
  const rootCall = { customer_name: 'Sarah Miller', description: 'Kitchen faucet leaking' };
  const withProfile = mailer.invoiceEmailBodies({ company, rootCall, inv, settings, payUrl: 'https://example.test/pay/x', profile });
  assert.ok(withProfile.html.includes(profile.logoUrl), 'invoice email hides company logo');
  assert.ok(withProfile.html.includes('12 Main St'), 'invoice email hides company address');
  assert.ok(withProfile.html.includes('555-0100'), 'invoice email hides company phone');
  assert.ok(withProfile.text.includes('12 Main St'), 'invoice text email hides company address');
  const withoutProfile = mailer.invoiceEmailBodies({ company, rootCall, inv, settings, payUrl: 'https://example.test/pay/x', profile: null });
  assert.ok(!withoutProfile.html.includes('<img'), 'invoice email without a profile renders a stray image');
  assert.ok(withoutProfile.subject.includes('Handyman Co'), 'invoice subject lost company name without profile');
}

console.log('proposals.test.js PASS');
