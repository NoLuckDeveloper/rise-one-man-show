'use strict';
// End-to-end company-profile/logo + proposals flows over HTTP against a
// real Postgres. SKIPPED unless RISE_TEST_DATABASE_URL is set (e.g. a
// scratch database): the suite truncates every tenant table first, so never
// point it at a real database.
//   RISE_TEST_DATABASE_URL=postgres://postgres:secret@localhost:5432/rise_test node tests/http-proposals.test.js
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

if (!process.env.RISE_TEST_DATABASE_URL) {
  console.log('http-proposals.test.js SKIP (RISE_TEST_DATABASE_URL not set)');
  process.exit(0);
}

process.env.DATABASE_URL = process.env.RISE_TEST_DATABASE_URL;
process.env.SESSION_SECRET = 'proposals-test-secret';
process.env.RESEND_API_KEY = 're_test_key';
delete process.env.STRIPE_SECRET_KEY;
delete process.env.STRIPE_PUBLISHABLE_KEY;
delete process.env.STRIPE_PRICE_ID;
delete process.env.STRIPE_WEBHOOK_SECRET;

const db = require('../server/db');
const { app } = require('../server/index');
const { signaturePng, blankPng, logoPng, dataUrl } = require('./png-helper');

// Capture Resend calls instead of hitting the network; every other fetch
// (including this test's own HTTP calls) passes through to real fetch.
const resendCalls = [];
const realFetch = global.fetch;
global.fetch = async (url, opts) => {
  if (String(url).startsWith('https://api.resend.com/')) {
    resendCalls.push({ url, body: JSON.parse(opts.body) });
    return { ok: true, json: async () => ({ id: 're_test_1' }) };
  }
  return realFetch(url, opts);
};

let base;
let server;

function cookieFrom(res) {
  const set = res.headers.get('set-cookie') || '';
  const m = set.match(/sid=[^;]+/);
  return m ? m[0] : '';
}

function form(fields) {
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries(fields)) {
    if (Array.isArray(v)) v.forEach((x) => p.append(k, x));
    else if (v !== undefined) p.append(k, v);
  }
  return p;
}

async function post(pathname, fields, cookie) {
  return fetch(base + pathname, {
    method: 'POST',
    redirect: 'manual',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', ...(cookie ? { Cookie: cookie } : {}) },
    body: form(fields),
  });
}

async function get(pathname, cookie) {
  return fetch(base + pathname, { redirect: 'manual', headers: cookie ? { Cookie: cookie } : {} });
}

function settingsForm(overrides = {}) {
  return {
    hourly_rate: '100.00', tax_percent: '10', parts_multiplier: '1',
    reminder_in: '08:30', reminder_out: '16:30',
    pay_anchor: '2026-10-11', pay_cycle_days: '14',
    quarter_start: '2026-10-01', quarter_end: '2026-12-31',
    profile_display_name: '', profile_address: '', profile_phone: '', profile_email: '',
    ...overrides,
  };
}

(async () => {
  await db.migrate();
  await db.q('TRUNCATE companies, users, sessions, subscriptions, billing_events, company_settings, calls, job_reports, trips, punches, gas_purchases, maintenance_receipts, customers, trip_positions, proposals RESTART IDENTITY CASCADE');

  server = app.listen(0);
  await new Promise((r) => server.on('listening', r));
  base = `http://127.0.0.1:${server.address().port}`;

  // Setup: company A (owner + tech) and company B (owner, for isolation).
  const signupA = await post('/signup', { company_name: 'Acme Handyman', owner_name: 'Owner A', email: 'ownera@prop.test', password: 'password123', plan_tier: 'team10' });
  assert.strictEqual(signupA.status, 302);
  const ownerA = cookieFrom(signupA);
  const coA = await db.one('SELECT * FROM companies WHERE name = $1', ['Acme Handyman']);
  const techAdd = await post('/app/users', { name: 'Tech A', email: 'techa@prop.test', password: 'password123', role: 'tech' }, ownerA);
  assert.strictEqual(techAdd.status, 302);
  const techA = cookieFrom(await post('/login', { email: 'techa@prop.test', password: 'password123' }));
  const signupB = await post('/signup', { company_name: 'Other Co', owner_name: 'Owner B', email: 'ownerb@prop.test', password: 'password123', plan_tier: 'solo' });
  assert.strictEqual(signupB.status, 302);
  const ownerB = cookieFrom(signupB);
  assert.ok(ownerA && techA && ownerB, 'setup logins failed');

  // Seed a completed call + report so the invoice page renders.
  const invCall = await db.one(
    "INSERT INTO calls (company_id, customer_name, address, description, status, completed_at) VALUES ($1,'Invoice Cust','1 Job St','Faucet swap','completed',now()) RETURNING *",
    [coA.id]);
  await db.q('UPDATE calls SET root_call_id = id WHERE id = $1', [invCall.id]);
  await db.q('INSERT INTO job_reports (call_id, company_id, parts, complete) VALUES ($1,$2,$3,true)',
    [invCall.id, coA.id, JSON.stringify([{ qty: 1, description: 'Faucet', costCents: 4200 }])]);

  // 1. Company profile saves; invoice shows it (no logo yet).
  const prof = await post('/app/settings', settingsForm({
    profile_display_name: 'Handyman Co', profile_address: '12 Main St, Marble Falls, TX',
    profile_phone: '555-0100', profile_email: 'office@handyman.test',
  }), ownerA);
  assert.strictEqual(prof.status, 302, 'profile save failed');
  const settings = await db.one('SELECT * FROM company_settings WHERE company_id = $1', [coA.id]);
  assert.strictEqual(settings.profile_display_name, 'Handyman Co');
  assert.strictEqual(settings.profile_address, '12 Main St, Marble Falls, TX');
  assert.strictEqual(settings.profile_phone, '555-0100');
  assert.strictEqual(settings.profile_email, 'office@handyman.test');
  assert.strictEqual(settings.logo_data_url, null);
  const invNoLogo = await (await get(`/app/calls/${invCall.id}/invoice`, ownerA)).text();
  assert.ok(invNoLogo.includes('Handyman Co'), 'invoice hides company name');
  assert.ok(invNoLogo.includes('12 Main St'), 'invoice hides company address');
  assert.ok(invNoLogo.includes('555-0100'), 'invoice hides company phone');
  assert.ok(invNoLogo.includes('office@handyman.test'), 'invoice hides company email');
  assert.ok(invNoLogo.includes('$46.20'), 'invoice total wrong (0 hrs + $42 part + 10% tax)');
  assert.ok(!invNoLogo.includes('data:image/'), 'invoice shows a logo with none uploaded');

  // 2. Logo upload: the image is stored as a data URL in the database —
  // no file is created under public/uploads — and the invoice page inlines it.
  const logoRes = await post('/app/settings', settingsForm({
    profile_display_name: 'Handyman Co', profile_address: '12 Main St, Marble Falls, TX',
    profile_phone: '555-0100', profile_email: 'office@handyman.test',
    logo_data_url: dataUrl(logoPng()),
  }), ownerA);
  assert.strictEqual(logoRes.status, 302, 'logo upload failed');
  const withLogo = await db.one('SELECT logo_data_url FROM company_settings WHERE company_id = $1', [coA.id]);
  assert.ok(withLogo.logo_data_url && withLogo.logo_data_url.startsWith('data:image/png;base64,'), 'logo not stored as a data URL');
  assert.strictEqual(withLogo.logo_data_url, dataUrl(logoPng()), 'stored logo data URL differs from the upload');
  assert.ok(!fs.existsSync(path.join(__dirname, '..', 'public', 'uploads')), 'logo upload created files under public/uploads');
  const invLogo = await (await get(`/app/calls/${invCall.id}/invoice`, ownerA)).text();
  assert.ok(invLogo.includes(withLogo.logo_data_url), 'invoice page does not inline the uploaded logo');

  // 3. Invalid logo is rejected and leaves the stored logo alone.
  const badLogo = await post('/app/settings', settingsForm({ logo_data_url: 'data:image/png;base64,!!!!' }), ownerA);
  assert.strictEqual(badLogo.status, 302);
  assert.ok(String(badLogo.headers.get('location')).includes('err='), 'invalid logo did not redirect with an error');
  assert.strictEqual((await db.one('SELECT logo_data_url FROM company_settings WHERE company_id = $1', [coA.id])).logo_data_url, withLogo.logo_data_url, 'invalid logo overwrote the good one');

  // 4. Proposal create (owner) — itemized, with a customer note.
  const mkCall = await post('/app/calls', { customer_name: 'Sarah Miller', description: 'Kitchen faucet leaking', customer_email: 'sarah@example.test' }, ownerA);
  assert.strictEqual(mkCall.status, 302);
  const call = await db.one("SELECT * FROM calls WHERE description = $1", ['Kitchen faucet leaking']);
  const newForm = await (await get(`/app/calls/${call.id}/proposals/new`, ownerA)).text();
  assert.ok(newForm.includes('Line items'), 'proposal form missing line items');
  const create = await post(`/app/calls/${call.id}/proposals`, {
    item_qty: ['1', '2'], item_desc: ['Faucet install', 'Supply pipe'], item_cost: ['150.00', '12.50'],
    display_mode: 'itemized', customer_note: 'Two-day job.',
  }, ownerA);
  assert.strictEqual(create.status, 302, 'proposal create failed');
  const prop1 = await db.one('SELECT * FROM proposals WHERE call_id = $1', [call.id]);
  assert.strictEqual(prop1.status, 'draft');
  assert.strictEqual(prop1.display_mode, 'itemized');
  assert.strictEqual(prop1.items.length, 2);
  assert.strictEqual(prop1.customer_note, 'Two-day job.');
  assert.ok(prop1.token && prop1.token.length >= 32, 'proposal token missing/short');
  const detail = await (await get(`/app/calls/${call.id}/proposals/${prop1.id}`, ownerA)).text();
  assert.ok(detail.includes('$192.50'), 'proposal detail total wrong (175 + 10% tax)');
  assert.ok(detail.includes('Faucet install'), 'proposal detail hides line items');
  assert.ok(detail.includes('Send to customer'), 'proposal detail missing send button');
  const jobPage = await (await get(`/app/calls/${call.id}`, ownerA)).text();
  assert.ok(jobPage.includes('Proposals'), 'job page hides proposals section');
  assert.ok(jobPage.includes('$192.50') && jobPage.includes('Draft'), 'job page hides proposal status/total');

  // 5. Send (itemized): Resend gets the lines, the logo and the link.
  const before = resendCalls.length;
  const send = await post(`/app/calls/${call.id}/proposals/${prop1.id}/send`, {}, ownerA);
  assert.strictEqual(send.status, 302, 'proposal send failed');
  const sent = await db.one('SELECT * FROM proposals WHERE id = $1', [prop1.id]);
  assert.strictEqual(sent.status, 'sent');
  assert.ok(sent.sent_at, 'sent_at not stamped');
  assert.strictEqual(sent.emailed_to, 'sarah@example.test');
  assert.strictEqual(resendCalls.length, before + 1, 'proposal email was not sent');
  const email = resendCalls[resendCalls.length - 1].body;
  assert.deepStrictEqual(email.to, ['sarah@example.test']);
  assert.ok(email.subject.includes('$192.50'), 'proposal email subject missing total');
  assert.ok(email.html.includes('Faucet install'), 'itemized proposal email hides lines');
  assert.ok(email.html.includes(withLogo.logo_data_url), 'proposal email hides company logo');
  assert.ok(email.html.includes(`/proposal/${prop1.token}`), 'proposal email missing the public link');

  // 6. Public page (itemized) + approval requires a signature.
  const pub = await (await get(`/proposal/${prop1.token}`)).text();
  assert.ok(pub.includes('Faucet install'), 'public proposal hides itemized lines');
  assert.ok(pub.includes('$192.50'), 'public proposal hides total');
  assert.ok(pub.includes('id="sig-pad"'), 'public proposal missing signature pad');
  assert.ok(pub.includes('Request changes'), 'public proposal missing request-changes button');
  assert.ok(pub.includes('Handyman Co') && pub.includes('12 Main St'), 'public proposal hides company profile');
  assert.strictEqual((await get('/proposal/does-not-exist')).status, 404, 'bad proposal token did not 404');
  assert.strictEqual((await post('/proposal/does-not-exist/approve', { signature_data_url: dataUrl(signaturePng()) })).status, 404, 'approve on bad token did not 404');

  const noSig = await post(`/proposal/${prop1.token}/approve`, {});
  assert.strictEqual(noSig.status, 302);
  assert.ok(String(noSig.headers.get('location')).includes('err='), 'approval without a signature did not error');
  assert.strictEqual((await db.one('SELECT status FROM proposals WHERE id = $1', [prop1.id])).status, 'sent', 'approval without a signature was recorded');
  const blankSig = await post(`/proposal/${prop1.token}/approve`, { signature_data_url: dataUrl(blankPng()) });
  assert.ok(String(blankSig.headers.get('location')).includes('err='), 'approval with a blank signature did not error');
  assert.strictEqual((await db.one('SELECT status FROM proposals WHERE id = $1', [prop1.id])).status, 'sent', 'blank-signature approval was recorded');

  const approve = await post(`/proposal/${prop1.token}/approve`, { signature_data_url: dataUrl(signaturePng()) });
  assert.strictEqual(approve.status, 302, 'approval with signature failed');
  const approved = await db.one('SELECT * FROM proposals WHERE id = $1', [prop1.id]);
  assert.strictEqual(approved.status, 'approved');
  assert.ok(approved.signature_data_url && approved.signature_data_url.startsWith('data:image/png;base64,'), 'signature not stored');
  assert.ok(approved.signed_at, 'signed_at not stamped');
  assert.ok(approved.decided_at, 'decided_at not stamped');
  assert.ok(Date.now() - new Date(approved.signed_at).getTime() < 60000, 'signed_at is not the approval time');
  const pubAfter = await (await get(`/proposal/${prop1.token}`)).text();
  assert.ok(pubAfter.includes('Approved'), 'public page hides the recorded approval');
  assert.ok(pubAfter.includes('data:image/png;base64,'), 'public page hides the recorded signature');
  assert.ok(pubAfter.includes('Signed'), 'public page hides the signature date/time');
  assert.ok(!pubAfter.includes('id="sig-pad"'), 'public page still offers approval after a decision');
  const jobAfter = await (await get(`/app/calls/${call.id}`, ownerA)).text();
  assert.ok(jobAfter.includes('Approved'), 'owner job page hides the approval');
  assert.ok(jobAfter.includes('data:image/png;base64,'), 'owner job page hides the signature');
  assert.ok(jobAfter.includes('Signed'), 'owner job page hides the signature date/time');
  const approveAgain = await post(`/proposal/${prop1.token}/approve`, { signature_data_url: dataUrl(signaturePng()) });
  assert.strictEqual(approveAgain.status, 302);
  assert.strictEqual((await db.one('SELECT status FROM proposals WHERE id = $1', [prop1.id])).status, 'approved', 're-approval changed a decided proposal');

  // 7. Request-changes flow (total-only proposal): no signature needed.
  const create2 = await post(`/app/calls/${call.id}/proposals`, {
    item_qty: ['1'], item_desc: ['Water heater swap'], item_cost: ['800.00'],
    display_mode: 'total_only', customer_note: '',
  }, ownerA);
  assert.strictEqual(create2.status, 302);
  const prop2 = await db.one('SELECT * FROM proposals WHERE call_id = $1 AND id <> $2', [call.id, prop1.id]);
  assert.strictEqual(prop2.display_mode, 'total_only');
  const send2 = await post(`/app/calls/${call.id}/proposals/${prop2.id}/send`, {}, ownerA);
  assert.strictEqual(send2.status, 302);
  const email2 = resendCalls[resendCalls.length - 1].body;
  assert.ok(!email2.html.includes('Water heater swap'), 'total-only email leaks line items');
  assert.ok(email2.html.includes('$880.00'), 'total-only email hides the total');
  const pub2 = await (await get(`/proposal/${prop2.token}`)).text();
  assert.ok(!pub2.includes('Water heater swap'), 'total-only public page leaks line items');
  assert.ok(pub2.includes('$880.00'), 'total-only public page hides the total');
  const noNote = await post(`/proposal/${prop2.token}/request-changes`, { note: '' });
  assert.ok(String(noNote.headers.get('location')).includes('err='), 'request-changes without a note did not error');
  assert.strictEqual((await db.one('SELECT status FROM proposals WHERE id = $1', [prop2.id])).status, 'sent', 'empty request-changes was recorded');
  const rc = await post(`/proposal/${prop2.token}/request-changes`, { note: 'Use a taller unit' });
  assert.strictEqual(rc.status, 302);
  const changed = await db.one('SELECT * FROM proposals WHERE id = $1', [prop2.id]);
  assert.strictEqual(changed.status, 'changes_requested');
  assert.strictEqual(changed.customer_decision_note, 'Use a taller unit');
  assert.ok(changed.decided_at && !changed.signed_at, 'request-changes wrongly stamped a signature time');
  const pub2After = await (await get(`/proposal/${prop2.token}`)).text();
  assert.ok(pub2After.includes('Changes requested'), 'public page hides the changes request');
  assert.ok(pub2After.includes('Use a taller unit'), 'public page hides the customer note');
  assert.ok(!pub2After.includes('id="sig-pad"'), 'public page still offers approval after changes requested');
  const approveDecided = await post(`/proposal/${prop2.token}/approve`, { signature_data_url: dataUrl(signaturePng()) });
  assert.strictEqual(approveDecided.status, 302);
  assert.strictEqual((await db.one('SELECT status FROM proposals WHERE id = $1', [prop2.id])).status, 'changes_requested', 'approval overrode a changes request');

  // 8. Owner edits a changes-requested proposal and resends (same token).
  const editForm = await get(`/app/calls/${call.id}/proposals/${prop2.id}/edit`, ownerA);
  assert.strictEqual(editForm.status, 200, 'owner cannot edit a changes-requested proposal');
  const edit = await post(`/app/calls/${call.id}/proposals/${prop2.id}/edit`, {
    item_qty: ['1'], item_desc: ['Water heater swap (tall)'], item_cost: ['850.00'],
    display_mode: 'itemized', customer_note: '',
  }, ownerA);
  assert.strictEqual(edit.status, 302, 'proposal edit failed');
  const edited = await db.one('SELECT * FROM proposals WHERE id = $1', [prop2.id]);
  assert.strictEqual(edited.items[0].description, 'Water heater swap (tall)');
  assert.strictEqual(edited.display_mode, 'itemized');
  const tokenBefore = edited.token;
  const resend = await post(`/app/calls/${call.id}/proposals/${prop2.id}/send`, {}, ownerA);
  assert.strictEqual(resend.status, 302, 'proposal resend failed');
  const resent = await db.one('SELECT * FROM proposals WHERE id = $1', [prop2.id]);
  assert.strictEqual(resent.status, 'sent');
  assert.strictEqual(resent.token, tokenBefore, 'resend changed the token');
  assert.strictEqual(resent.customer_decision_note, null, 'resend kept the old changes note');
  assert.strictEqual(resent.decided_at, null, 'resend kept the old decision time');
  const approveResent = await post(`/proposal/${prop2.token}/approve`, { signature_data_url: dataUrl(signaturePng()) });
  assert.strictEqual(approveResent.status, 302);
  assert.strictEqual((await db.one('SELECT status FROM proposals WHERE id = $1', [prop2.id])).status, 'approved', 'resent proposal could not be approved');

  // 9. Editing a sent proposal is refused (draft/changes-requested only).
  const create3 = await post(`/app/calls/${call.id}/proposals`, {
    item_qty: ['1'], item_desc: ['Gutter clean'], item_cost: ['120.00'], display_mode: 'itemized', customer_note: '',
  }, ownerA);
  assert.strictEqual(create3.status, 302);
  const prop3 = await db.one('SELECT * FROM proposals WHERE call_id = $1 AND status = $2 ORDER BY id DESC LIMIT 1', [call.id, 'draft']);
  await post(`/app/calls/${call.id}/proposals/${prop3.id}/send`, {}, ownerA);
  const editSent = await get(`/app/calls/${call.id}/proposals/${prop3.id}/edit`, ownerA);
  assert.strictEqual(editSent.status, 302);
  assert.ok(String(editSent.headers.get('location')).includes('err='), 'editing a sent proposal did not error');

  // 10. Role gates: techs cannot create, send, or view proposals in-app,
  // and the job page hides the proposals section from them entirely.
  assert.strictEqual((await post(`/app/calls/${call.id}/proposals`, { item_qty: ['1'], item_desc: ['X'], item_cost: ['1.00'] }, techA)).status, 403, 'tech created a proposal');
  assert.strictEqual((await get(`/app/calls/${call.id}/proposals/${prop1.id}`, techA)).status, 403, 'tech viewed a proposal');
  assert.strictEqual((await get(`/app/calls/${call.id}/proposals/${prop1.id}/edit`, techA)).status, 403, 'tech opened the proposal editor');
  assert.strictEqual((await post(`/app/calls/${call.id}/proposals/${prop3.id}/send`, {}, techA)).status, 403, 'tech sent a proposal');
  const techJob = await (await get(`/app/calls/${call.id}`, techA)).text();
  assert.ok(!techJob.includes('Proposals'), 'tech job page leaks the proposals section');

  // 11. Cross-company isolation: another company's owner gets 404s in-app.
  assert.strictEqual((await get(`/app/calls/${call.id}/proposals/${prop1.id}`, ownerB)).status, 404, 'other company viewed a proposal');
  assert.strictEqual((await get(`/app/calls/${call.id}`, ownerB)).status, 404, 'other company opened the call');
  assert.strictEqual((await post(`/app/calls/${call.id}/proposals/${prop1.id}/send`, {}, ownerB)).status, 404, 'other company sent a proposal');

  // 12. Logo removal clears the stored data URL; the invoice renders
  // profile text only, exactly as with no logo uploaded.
  const remove = await post('/app/settings', settingsForm({ remove_logo: '1' }), ownerA);
  assert.strictEqual(remove.status, 302);
  assert.strictEqual((await db.one('SELECT logo_data_url FROM company_settings WHERE company_id = $1', [coA.id])).logo_data_url, null, 'logo data URL not cleared');
  const invNoLogoAgain = await (await get(`/app/calls/${invCall.id}/invoice`, ownerA)).text();
  assert.ok(!invNoLogoAgain.includes('data:image/'), 'invoice still shows a removed logo');

  console.log('http-proposals.test.js PASS');
  server.close();
  await db.pool.end();
})().catch(async (e) => {
  console.error('http-proposals.test.js FAIL:', e);
  try { server && server.close(); } catch (_) {}
  try { await db.pool.end(); } catch (_) {}
  process.exit(1);
});
