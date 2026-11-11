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
{
  // Labor is a separate line from the parts: estimated hours x hourly
  // rate, taxed with the rest of the subtotal like invoice labor.
  const t = computeProposal({
    items: [{ description: 'Garage door', qty: 1, unitCostCents: 120000 }],
    taxPercent: 10,
    laborHours: 4,
    hourlyRateCents: 8500,
  });
  assert.strictEqual(t.laborHours, 4);
  assert.strictEqual(t.laborRateCents, 8500);
  assert.strictEqual(t.laborCents, 34000);
  assert.strictEqual(t.subtotalCents, 154000);
  assert.strictEqual(t.taxCents, 15400);
  assert.strictEqual(t.totalCents, 169400);
}
{
  // Labor-only proposal: no parts at all.
  const t = computeProposal({ items: [], taxPercent: 0, laborHours: 3, hourlyRateCents: 5000 });
  assert.strictEqual(t.laborCents, 15000);
  assert.strictEqual(t.totalCents, 15000);
}
{
  // No labor args at all: backward compatible, no labor line.
  const t = computeProposal({ items: [{ description: 'X', qty: 1, unitCostCents: 100 }], taxPercent: 0 });
  assert.strictEqual(t.laborCents, 0);
  assert.strictEqual(t.totalCents, 100);
}
{
  // Parts are entered at cost and billed at cost x the parts multiplier,
  // like invoice parts. Jake's garage-door numbers: door cost $1,200 at
  // 1.8x = $2,160; labor 3 hrs x $95 = $285; subtotal $2,445; tax 8.25%.
  const t = computeProposal({
    items: [{ description: '16x7 Garage Door', qty: 1, unitCostCents: 120000 }],
    taxPercent: 8.25, laborHours: 3, hourlyRateCents: 9500, partsMultiplier: 1.8,
  });
  assert.strictEqual(t.lines[0].unitCostCents, 120000);
  assert.strictEqual(t.lines[0].lineCents, 216000);
  assert.strictEqual(t.laborCents, 28500);
  assert.strictEqual(t.subtotalCents, 244500);
  assert.strictEqual(t.taxCents, 20171);
  assert.strictEqual(t.totalCents, 264671);
  assert.strictEqual(t.multiplierApplied, true);
}
{
  // No multiplier (or 1x): billed equals cost, no markup flag.
  const t = computeProposal({ items: [{ description: 'X', qty: 2, unitCostCents: 5000 }], taxPercent: 0 });
  assert.strictEqual(t.lines[0].lineCents, 10000);
  assert.strictEqual(t.multiplierApplied, false);
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
  // A data-URL logo is referenced as a CID attachment (Gmail strips
  // data: images), never inlined.
  assert.ok(itemized.html.includes('cid:company-logo'), 'proposal email hides company logo');
  assert.ok(!itemized.html.includes(profile.logoUrl), 'proposal email inlines the logo as a data URL (Gmail strips those)');
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
  // Labor shows as its own line in the proposal email, hidden in total-only.
  const laborTotals = computeProposal({
    items: [{ description: 'Faucet install', qty: 1, unitCostCents: 15000 }],
    taxPercent: 10, laborHours: 2, hourlyRateCents: 10000,
  });
  const emailed = mailer.proposalEmailBodies({
    company, call,
    proposal: { display_mode: 'itemized', customer_note: '' },
    totals: laborTotals, proposalUrl: 'https://example.test/proposal/abc', profile,
  });
  assert.ok(emailed.html.includes('Labor — 2 hrs × $100.00/hr'), 'proposal email hides labor line');
  assert.ok(emailed.text.includes('Labor — 2 hrs × $100.00/hr'), 'proposal text email hides labor line');
  assert.ok(emailed.html.includes('$200.00'), 'proposal email hides labor amount');
  const totalOnlyLabor = mailer.proposalEmailBodies({
    company, call,
    proposal: { display_mode: 'total_only', customer_note: '' },
    totals: laborTotals, proposalUrl: 'https://example.test/proposal/abc', profile,
  });
  assert.ok(!totalOnlyLabor.html.includes('Labor —'), 'total-only email leaks labor line');
}
{
  const inv = {
    hours: 1.5, laborCents: 15000,
    partLines: [{ description: 'Faucet', qty: 1, costCents: 4200, billedCents: 4200 }],
    partsCents: 4200, subtotalCents: 19200, taxCents: 1920, totalCents: 21120, multiplierApplied: false,
  };
  const rootCall = { customer_name: 'Sarah Miller', description: 'Kitchen faucet leaking' };
  const withProfile = mailer.invoiceEmailBodies({ company, rootCall, inv, settings, payUrl: 'https://example.test/pay/x', profile });
  assert.ok(withProfile.html.includes('cid:company-logo'), 'invoice email hides company logo');
  assert.ok(!withProfile.html.includes(profile.logoUrl), 'invoice email inlines the logo as a data URL (Gmail strips those)');
  assert.ok(withProfile.html.includes('12 Main St'), 'invoice email hides company address');
  assert.ok(withProfile.html.includes('555-0100'), 'invoice email hides company phone');
  assert.ok(withProfile.text.includes('12 Main St'), 'invoice text email hides company address');
  const withoutProfile = mailer.invoiceEmailBodies({ company, rootCall, inv, settings, payUrl: 'https://example.test/pay/x', profile: null });
  assert.ok(!withoutProfile.html.includes('<img'), 'invoice email without a profile renders a stray image');
  assert.ok(withoutProfile.subject.includes('Handyman Co'), 'invoice subject lost company name without profile');
}

// --- Proposal views: labor line --------------------------------------------------
const views = require('../server/views');
const viewUser = { role: 'owner' };
const viewSub = { status: 'trialing', trial_end: new Date() };
const viewLaborTotals = computeProposal({
  items: [{ description: 'Garage door', qty: 1, unitCostCents: 120000 }],
  taxPercent: 0, laborHours: 2, hourlyRateCents: 10000,
});
{
  const form = views.proposalFormPage({ user: viewUser, sub: viewSub, company, flash: null, call: { customer_name: 'Test', description: 'Estimate to replace garage door' }, proposal: null, settings });
  assert.ok(form.includes('name="labor_hours"'), 'proposal form missing labor hours input');
  assert.ok(form.includes('Estimated hours to complete'), 'proposal form missing labor label');
  assert.ok(form.includes('$100.00/hr'), 'proposal form missing hourly rate note');
  assert.ok(!form.includes('× cost'), 'proposal form shows multiplier note at 1x');
  const editForm = views.proposalFormPage({ user: viewUser, sub: viewSub, company, flash: null, call: { customer_name: 'Test', description: 'Estimate' }, proposal: { id: 1, status: 'draft', display_mode: 'itemized', items: [], labor_hours: 2.5, customer_note: '' }, settings });
  assert.ok(editForm.includes('value="2.5"'), 'proposal edit form does not prefill labor hours');
}
{
  const detail = views.proposalDetailPage({ user: viewUser, sub: viewSub, company, flash: null, call: { customer_name: 'Test', description: 'Estimate' }, proposal: { id: 1, status: 'draft', display_mode: 'itemized' }, totals: viewLaborTotals, settings, recipientEmail: 'c@example.test', resendConfigured: true });
  assert.ok(detail.includes('Labor — 2 hrs × $100.00/hr'), 'proposal detail hides labor line');
  assert.ok(detail.includes('$200.00'), 'proposal detail hides labor amount');
  const noLabor = views.proposalDetailPage({ user: viewUser, sub: viewSub, company, flash: null, call: { customer_name: 'Test', description: 'Estimate' }, proposal: { id: 1, status: 'draft', display_mode: 'itemized' }, totals, settings, recipientEmail: null, resendConfigured: true });
  assert.ok(!noLabor.includes('Labor —'), 'proposal detail shows a labor line with no labor');
}
{
  const pub = views.proposalPage({ company, call: { customer_name: 'Test', description: 'Estimate' }, proposal: { id: 1, token: 'tok', status: 'sent', display_mode: 'itemized' }, totals: viewLaborTotals, profile: null, flash: null });
  assert.ok(pub.includes('Labor — 2 hrs × $100.00/hr'), 'public proposal hides labor line');
}
{
  // Parts multiplier: the form says so, the detail page marks the lines
  // and notes the markup, and the public proposal page carries no Rise
  // branding — only the company's own.
  const multSettings = { ...settings, parts_multiplier: 1.8 };
  const multForm = views.proposalFormPage({ user: viewUser, sub: viewSub, company, flash: null, call: { customer_name: 'Test', description: 'Estimate' }, proposal: null, settings: multSettings });
  assert.ok(multForm.includes('1.8× cost'), 'proposal form missing parts multiplier note');
  const multTotals = computeProposal({ items: [{ description: 'Garage Door', qty: 1, unitCostCents: 120000 }], taxPercent: 0, partsMultiplier: 1.8 });
  const multDetail = views.proposalDetailPage({ user: viewUser, sub: viewSub, company, flash: null, call: { customer_name: 'Test', description: 'Estimate' }, proposal: { id: 1, status: 'draft', display_mode: 'itemized' }, totals: multTotals, settings: multSettings, recipientEmail: null, resendConfigured: true });
  assert.ok(multDetail.includes('(× multiplier)'), 'proposal detail missing multiplier marker');
  assert.ok(multDetail.includes('Parts billed at a markup over cost'), 'proposal detail missing markup note');
  const multPub = views.proposalPage({ company, call: { customer_name: 'Test', description: 'Estimate' }, proposal: { id: 1, token: 'tok', status: 'sent', display_mode: 'itemized' }, totals: multTotals, profile: null, flash: null });
  assert.ok(!multPub.includes('logo-mark.png'), 'public proposal still shows the Rise logo');
  assert.ok(!multPub.includes('class="brand-rise"'), 'public proposal still shows the Rise wordmark');
  assert.ok(multPub.includes('(× multiplier)'), 'public proposal missing multiplier marker');
}

{
  // logoAttachment: a data-URL logo becomes a CID attachment; anything
  // else yields nothing to attach.
  const att = mailer.logoAttachment(profile);
  assert.ok(att, 'logoAttachment returned nothing for a data-URL logo');
  assert.strictEqual(att.content_id, 'company-logo');
  assert.strictEqual(att.filename, 'logo.png');
  assert.ok(att.content.length > 100, 'logo attachment content unexpectedly short');
  assert.strictEqual(mailer.logoAttachment(null), null, 'logoAttachment should be null without a profile');
  assert.strictEqual(mailer.logoAttachment({ logoUrl: 'https://example.test/logo.png' }), null, 'logoAttachment should be null for a plain URL');
  assert.strictEqual(mailer.logoAttachment({ logoUrl: '' }), null, 'logoAttachment should be null without a logo');
}

// --- Proposals list page + nav menu ---------------------------------------------
{
  const sent = {
    proposal: { id: 1, status: 'sent', display_mode: 'itemized', sent_at: '2026-11-11T11:42:00Z', customer_note: '', customer_decision_note: '' },
    call: { id: 1, customer_name: 'Test', description: 'Estimate to replace garage door' },
    totals: computeProposal({ items: [{ description: '16x7 Garage Door', qty: 1, unitCostCents: 120000 }], taxPercent: 8.25, laborHours: 3, hourlyRateCents: 9500, partsMultiplier: 1.8 }),
  };
  const changes = {
    proposal: { id: 2, status: 'changes_requested', display_mode: 'itemized', sent_at: '2026-11-11T11:42:00Z', customer_note: '', customer_decision_note: 'Change wording' },
    call: { id: 1, customer_name: 'Test', description: 'Estimate to replace garage door' },
    totals: computeProposal({ items: [], taxPercent: 8.25, laborHours: 1, hourlyRateCents: 9500 }),
  };
  const page = views.proposalsPage({ user: viewUser, sub: viewSub, company, flash: null, proposals: [sent, changes] });
  assert.ok(page.includes('Proposals sent'), 'proposals page missing heading');
  assert.ok(page.includes('$2,646.71'), 'proposals page missing multiplier total');
  assert.ok(page.includes('Sent'), 'proposals page missing sent status');
  assert.ok(page.includes('Changes requested'), 'proposals page missing changes-requested status');
  assert.ok(page.includes('Change wording'), 'proposals page missing change request note');
  assert.ok(page.includes('/app/calls/1/proposals/1'), 'proposals page missing view link');
  const empty = views.proposalsPage({ user: viewUser, sub: viewSub, company, flash: null, proposals: [] });
  assert.ok(empty.includes('No proposals sent yet.'), 'proposals page missing empty state');
}
{
  // The tab bar is now a dropdown menu, with Proposals in it for
  // owners/admins and hidden from techs.
  const page = views.proposalsPage({ user: viewUser, sub: viewSub, company, flash: null, proposals: [] });
  assert.ok(page.includes('<details class="nav-menu">'), 'nav menu missing');
  assert.ok(page.includes('<summary>☰ Proposals</summary>'), 'nav menu missing current-page label');
  assert.ok(page.includes('href="/app/proposals"'), 'nav menu missing Proposals link');
  assert.ok(!page.includes('class="tabs"'), 'old tab bar still rendered');
  const techPage = views.proposalsPage({ user: { role: 'tech' }, sub: viewSub, company, flash: null, proposals: [] });
  assert.ok(!techPage.includes('href="/app/proposals"'), 'techs see the Proposals link');
}

console.log('proposals.test.js PASS');
