'use strict';
// Rendered-copy tests for dispatch: assignee dropdown only for owner/admin,
// per-tech schedule filter only for owner/admin, assignee shown on cards.
// No DB queries run here (views only render).
const assert = require('node:assert');
const views = require('../server/views');

const company = { id: 1, name: 'Dispatch Co', plan_tier: 'team10' };
const sub = { status: 'trialing', trial_start: new Date(), trial_end: new Date(Date.now() + 5 * 86400000), current_period_end: null, payment_last4: null, payment_brand: null };
const owner = { id: 1, role: 'owner' };
const tech = { id: 2, role: 'tech' };
const assignees = [
  { id: 2, name: 'Tech One', role: 'tech' },
  { id: 3, name: 'Tech Two', role: 'tech' },
];
const assignedCall = { id: 1, customer_name: 'Cust A', description: 'Fix faucet', status: 'bucket', assignee_name: 'Tech One' };
const unassignedCall = { id: 2, customer_name: 'Cust B', description: 'Fix door', status: 'bucket', assignee_name: null };

// Call form: owner/admin get the dropdown, techs do not.
const ownerForm = views.callFormPage({ user: owner, sub, company, flash: null, call: null, prefill: null, assignees, canAssign: true });
assert.ok(ownerForm.includes('Assigned to'), 'owner form missing assignee dropdown');
assert.ok(ownerForm.includes('Tech One (tech)'), 'owner form missing tech option');
assert.ok(ownerForm.includes('<option value="">Unassigned</option>'), 'owner form missing Unassigned option');
const techForm = views.callFormPage({ user: tech, sub, company, flash: null, call: assignedCall, prefill: null, assignees, canAssign: false });
assert.ok(!techForm.includes('Assigned to'), 'tech form leaks assignee dropdown');
// Edit form preselects the current assignee for owner/admin.
const editForm = views.callFormPage({ user: owner, sub, company, flash: null, call: { ...assignedCall, assigned_user_id: 2 }, prefill: null, assignees, canAssign: true });
assert.ok(editForm.includes('<option value="2" selected>'), 'edit form does not preselect current assignee');

// Call cards show the assignee, or Unassigned.
assert.ok(views.callCard(assignedCall).includes('👤 Tech One'), 'card missing assignee name');
assert.ok(views.callCard(unassignedCall).includes('👤 Unassigned'), 'card missing Unassigned label');

// Schedule filter only for owner/admin.
const ownerSched = views.schedulePage({ user: owner, sub, company, flash: null, bucket: [assignedCall], byDay: {}, todayGas: [], todayMaint: [], assignees, techFilter: 2, canFilter: true });
assert.ok(ownerSched.includes('Show schedule for'), 'owner schedule missing tech filter');
assert.ok(ownerSched.includes('<option value="2" selected>'), 'tech filter does not preselect');
const techSched = views.schedulePage({ user: tech, sub, company, flash: null, bucket: [assignedCall], byDay: {}, todayGas: [], todayMaint: [], assignees: [], techFilter: null, canFilter: false });
assert.ok(!techSched.includes('Show schedule for'), 'tech schedule leaks tech filter');

console.log('views-dispatch.test.js PASS');
