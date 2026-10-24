'use strict';
// End-to-end dispatch flows over HTTP against a real Postgres. SKIPPED unless
// RISE_TEST_DATABASE_URL is set (e.g. a scratch database): the suite
// truncates every tenant table first, so never point it at a real database.
//   RISE_TEST_DATABASE_URL=postgres://postgres:secret@localhost:5432/rise_test node tests/http-dispatch.test.js
const assert = require('node:assert');

if (!process.env.RISE_TEST_DATABASE_URL) {
  console.log('http-dispatch.test.js SKIP (RISE_TEST_DATABASE_URL not set)');
  process.exit(0);
}

process.env.DATABASE_URL = process.env.RISE_TEST_DATABASE_URL;
process.env.SESSION_SECRET = 'dispatch-test-secret';
delete process.env.STRIPE_SECRET_KEY;
delete process.env.STRIPE_PUBLISHABLE_KEY;
delete process.env.STRIPE_PRICE_ID;
delete process.env.STRIPE_WEBHOOK_SECRET;

const db = require('../server/db');
const { app } = require('../server/index');

let base;
let server;

function cookieFrom(res) {
  const set = res.headers.get('set-cookie') || '';
  const m = set.match(/sid=[^;]+/);
  return m ? m[0] : '';
}

async function post(path, fields, cookie) {
  const res = await fetch(base + path, {
    method: 'POST',
    redirect: 'manual',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', ...(cookie ? { Cookie: cookie } : {}) },
    body: new URLSearchParams(fields),
  });
  return res;
}

async function get(path, cookie) {
  return fetch(base + path, { redirect: 'manual', headers: cookie ? { Cookie: cookie } : {} });
}

(async () => {
  await db.migrate();
  await db.q('TRUNCATE companies, users, sessions, subscriptions, billing_events, company_settings, calls, job_reports, trips, punches, gas_purchases, maintenance_receipts, customers, trip_positions RESTART IDENTITY CASCADE');

  server = app.listen(0);
  await new Promise((r) => server.on('listening', r));
  base = `http://127.0.0.1:${server.address().port}`;

  // Setup: owner on team10 (room for 3 users), two techs.
  const signup = await post('/signup', { company_name: 'Dispatch Co', owner_name: 'Owner', email: 'owner@dispatch.test', password: 'password123', plan_tier: 'team10' });
  assert.strictEqual(signup.status, 302);
  const ownerCookie = cookieFrom(signup);
  assert.ok(ownerCookie, 'signup did not set a session cookie');
  const co = await db.one('SELECT * FROM companies WHERE name = $1', ['Dispatch Co']);
  for (const [name, email] of [['Tech One', 'techone@dispatch.test'], ['Tech Two', 'techtwo@dispatch.test']]) {
    const r = await post('/app/users', { name, email, password: 'password123', role: 'tech' }, ownerCookie);
    assert.strictEqual(r.status, 302);
  }
  const tech1 = await db.one('SELECT * FROM users WHERE email = $1', ['techone@dispatch.test']);
  const tech2 = await db.one('SELECT * FROM users WHERE email = $1', ['techtwo@dispatch.test']);
  const tech1Cookie = cookieFrom(await post('/login', { email: 'techone@dispatch.test', password: 'password123' }));
  const tech2Cookie = cookieFrom(await post('/login', { email: 'techtwo@dispatch.test', password: 'password123' }));
  assert.ok(tech1Cookie && tech2Cookie, 'tech logins did not set cookies');

  // 1. Owner assigns on create; unassigned stays NULL.
  const mk = async (desc, extra) => {
    const r = await post('/app/calls', { customer_name: 'Cust ' + desc, description: desc, ...extra }, ownerCookie);
    assert.strictEqual(r.status, 302, `create ${desc} failed`);
    return db.one('SELECT * FROM calls WHERE description = $1', [desc]);
  };
  const callA = await mk('Call A tech1 bucket', { assigned_user_id: String(tech1.id) });
  const callB = await mk('Call B unassigned bucket', {});
  const callC = await mk('Call C tech2 bucket', { assigned_user_id: String(tech2.id) });
  const callD = await mk('Call D tech1 scheduled', { assigned_user_id: String(tech1.id), scheduled_date: '2030-01-06' });
  const callF = await mk('Call F unassigned reassign', {});
  assert.strictEqual(callA.assigned_user_id, tech1.id, 'owner create did not assign to tech1');
  assert.strictEqual(callB.assigned_user_id, null, 'unassigned create was not NULL');
  assert.strictEqual(callC.assigned_user_id, tech2.id, 'owner create did not assign to tech2');
  assert.strictEqual(callD.status, 'scheduled', 'dated create was not scheduled');

  // 2. Owner schedule shows all + assignee labels; per-tech filter works.
  const ownerSched = await (await get('/app', ownerCookie)).text();
  for (const d of ['Call A tech1 bucket', 'Call B unassigned bucket', 'Call C tech2 bucket', 'Call D tech1 scheduled']) {
    assert.ok(ownerSched.includes(d), `owner schedule missing ${d}`);
  }
  assert.ok(ownerSched.includes('👤 Tech One'), 'owner schedule missing assignee label');
  assert.ok(ownerSched.includes('👤 Unassigned'), 'owner schedule missing Unassigned label');
  assert.ok(ownerSched.includes('Show schedule for'), 'owner schedule missing tech filter');
  const filtered = await (await get(`/app?tech=${tech1.id}`, ownerCookie)).text();
  assert.ok(filtered.includes('Call A tech1 bucket') && filtered.includes('Call D tech1 scheduled'), 'tech filter missing tech1 calls');
  assert.ok(!filtered.includes('Call B unassigned bucket') && !filtered.includes('Call C tech2 bucket'), 'tech filter leaks other calls');
  const bogus = await (await get('/app?tech=999999', ownerCookie)).text();
  assert.ok(bogus.includes('Call A tech1 bucket') && bogus.includes('Call C tech2 bucket'), 'bogus tech filter was not ignored');

  // 3. Tech schedule shows only their own calls.
  const tech1Sched = await (await get('/app', tech1Cookie)).text();
  assert.ok(tech1Sched.includes('Call A tech1 bucket') && tech1Sched.includes('Call D tech1 scheduled'), 'tech1 schedule missing own calls');
  assert.ok(!tech1Sched.includes('Call B unassigned bucket') && !tech1Sched.includes('Call C tech2 bucket'), 'tech1 schedule leaks other calls');
  assert.ok(!tech1Sched.includes('Show schedule for'), 'tech schedule leaks filter');

  // 4. Edit form: dropdown for owner, hidden for tech.
  const ownerEdit = await (await get(`/app/calls/${callA.id}/edit`, ownerCookie)).text();
  assert.ok(ownerEdit.includes('Assigned to'), 'owner edit missing assignee dropdown');
  const techEdit = await (await get(`/app/calls/${callA.id}/edit`, tech1Cookie)).text();
  assert.ok(!techEdit.includes('Assigned to'), 'tech edit leaks assignee dropdown');

  // 5. Tech cannot assign or reassign: submitted values are ignored.
  const techCreated = await post('/app/calls', { customer_name: 'Cust TechMade', description: 'Tech made call', assigned_user_id: String(tech2.id) }, tech1Cookie);
  assert.strictEqual(techCreated.status, 302);
  const techMade = await db.one('SELECT * FROM calls WHERE description = $1', ['Tech made call']);
  assert.notStrictEqual(techMade.assigned_user_id, tech2.id, 'tech create assigned to another tech');
  assert.strictEqual(techMade.assigned_user_id, tech1.id, 'tech create was not assigned to the creator');
  const techReassign = await post(`/app/calls/${callA.id}/edit`, { customer_name: 'Cust Call A tech1 bucket', description: 'Call A tech1 bucket', assigned_user_id: String(tech2.id) }, tech1Cookie);
  assert.strictEqual(techReassign.status, 302);
  const callAAfter = await db.one('SELECT * FROM calls WHERE id = $1', [callA.id]);
  assert.strictEqual(callAAfter.assigned_user_id, tech1.id, 'tech edit reassigned the call');

  // 6. Owner reassign works (unassigned -> tech2).
  const ownerReassign = await post(`/app/calls/${callF.id}/edit`, { customer_name: 'Cust Call F unassigned reassign', description: 'Call F unassigned reassign', assigned_user_id: String(tech2.id) }, ownerCookie);
  assert.strictEqual(ownerReassign.status, 302);
  const callFAfter = await db.one('SELECT * FROM calls WHERE id = $1', [callF.id]);
  assert.strictEqual(callFAfter.assigned_user_id, tech2.id, 'owner reassign did not take effect');

  // 7. Direct URLs: 404 for another tech's call and for unassigned; 200 for own.
  assert.strictEqual((await get(`/app/calls/${callC.id}`, tech1Cookie)).status, 404, 'tech1 opened tech2 call');
  assert.strictEqual((await get(`/app/calls/${callB.id}`, tech1Cookie)).status, 404, 'tech1 opened unassigned call');
  assert.strictEqual((await get(`/app/calls/${callA.id}`, tech1Cookie)).status, 200, 'tech1 could not open own call');

  // 8. Run flow refused for others, allowed for own and for owner.
  assert.strictEqual((await post(`/app/calls/${callC.id}/start-travel`, {}, tech1Cookie)).status, 404, 'tech1 started travel on tech2 call');
  assert.strictEqual((await post(`/app/calls/${callA.id}/start-travel`, {}, tech1Cookie)).status, 302, 'tech1 could not start travel on own call');
  assert.strictEqual((await post(`/app/calls/${callC.id}/start-travel`, {}, ownerCookie)).status, 302, 'owner could not start travel');

  // 9. Native positions: 404 for another tech's open trip, 200 for the assignee.
  assert.strictEqual((await post('/app/native-positions', { call_id: String(callC.id), lat: '30.1', lng: '-98.1' }, tech1Cookie)).status, 404, 'tech1 posted positions to tech2 trip');
  const nativeOk = await post('/app/native-positions', { call_id: String(callC.id), lat: '30.1', lng: '-98.1' }, tech2Cookie);
  assert.strictEqual(nativeOk.status, 200, 'assignee could not post positions');
  assert.strictEqual((await nativeOk.json()).ok, true, 'native position post not ok');

  // 10. Completed lists filtered the same way.
  for (const [desc, assignee] of [['Done tech1', tech1.id], ['Done tech2', tech2.id], ['Done unassigned', null]]) {
    await db.q("INSERT INTO calls (company_id, customer_name, description, status, completed_at, assigned_user_id) VALUES ($1,$2,$3,'completed',now(),$4)", [co.id, 'Cust ' + desc, desc, assignee]);
  }
  const tech1Done = await (await get('/app/completed', tech1Cookie)).text();
  assert.ok(tech1Done.includes('Done tech1'), 'tech1 completed missing own job');
  assert.ok(!tech1Done.includes('Done tech2') && !tech1Done.includes('Done unassigned'), 'tech1 completed leaks other jobs');
  const ownerDone = await (await get('/app/completed', ownerCookie)).text();
  assert.ok(ownerDone.includes('Done tech1') && ownerDone.includes('Done tech2') && ownerDone.includes('Done unassigned'), 'owner completed missing jobs');

  // 11. Follow-up inherits the assignee; owner may reassign the child.
  const report = await post(`/app/calls/${callA.id}/report`, { work_performed: 'Fixed', follow_up: '1', follow_up_date: '2030-01-05' }, tech1Cookie);
  assert.strictEqual(report.status, 302, 'follow-up report save failed');
  const child = await db.one('SELECT * FROM calls WHERE parent_call_id = $1', [callA.id]);
  assert.ok(child, 'follow-up child was not created');
  assert.strictEqual(child.assigned_user_id, tech1.id, 'follow-up did not inherit assignee');
  const childReassign = await post(`/app/calls/${child.id}/edit`, { customer_name: child.customer_name, description: child.description, assigned_user_id: String(tech2.id) }, ownerCookie);
  assert.strictEqual(childReassign.status, 302);
  assert.strictEqual((await db.one('SELECT * FROM calls WHERE id = $1', [child.id])).assigned_user_id, tech2.id, 'owner could not reassign follow-up');

  // 12. Customer detail job list follows the same rule (directory stays wide).
  await mk('Detail tech1 job', { customer_name: 'Detail Cust', assigned_user_id: String(tech1.id) });
  await mk('Detail tech2 job', { customer_name: 'Detail Cust', assigned_user_id: String(tech2.id) });
  const detail = await (await get('/app/customers/Detail%20Cust', tech1Cookie)).text();
  assert.ok(detail.includes('Detail tech1 job'), 'customer detail missing tech1 job');
  assert.ok(!detail.includes('Detail tech2 job'), 'customer detail leaks tech2 job');

  console.log('http-dispatch.test.js PASS');
  server.close();
  await db.pool.end();
})().catch(async (e) => {
  console.error('http-dispatch.test.js FAIL:', e);
  try { server && server.close(); } catch (_) {}
  try { await db.pool.end(); } catch (_) {}
  process.exit(1);
});
