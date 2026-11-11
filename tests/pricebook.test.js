'use strict';
// Price book data logic against a fake in-memory DB, injected through the
// require cache before pricebook.js loads (it destructures ./db at require
// time, so the fake must be in place first). No real Postgres.
const assert = require('node:assert');

const dbPath = require.resolve('../server/db');
const state = { items: [], nextId: 1 };

const fakeDb = {
  pool: null,
  migrate: async () => {},
  billingEvent: async () => {},
  one: async (text, params) => {
    if (/^INSERT INTO price_book_items/.test(text)) {
      const row = { id: state.nextId++, company_id: params[0], name: params[1], part_number: params[2], description: params[3], cost_cents: params[4] };
      state.items.push(row);
      return row;
    }
    if (/^UPDATE price_book_items/.test(text)) {
      const row = state.items.find((x) => x.company_id === params[0] && x.id === params[1]);
      if (!row) return null;
      row.name = params[2];
      row.part_number = params[3];
      row.description = params[4];
      row.cost_cents = params[5];
      return row;
    }
    throw new Error(`fakeDb.one: unexpected query: ${text}`);
  },
  many: async (text, params) => {
    let rows = state.items.filter((x) => x.company_id === params[0]);
    if (/ILIKE/.test(text)) {
      const term = String(params[1]).replace(/%/g, '').toLowerCase();
      rows = rows.filter((x) => [x.name, x.part_number, x.description].some((v) => (v || '').toLowerCase().includes(term)));
    }
    return rows.slice().sort((a, b) => a.name.localeCompare(b.name));
  },
  q: async (text, params) => {
    if (/^DELETE FROM price_book_items/.test(text)) {
      const before = state.items.length;
      state.items = state.items.filter((x) => !(x.company_id === params[0] && x.id === params[1]));
      return { rowCount: before - state.items.length };
    }
    throw new Error(`fakeDb.q: unexpected query: ${text}`);
  },
};
require.cache[dbPath] = { id: dbPath, filename: dbPath, loaded: true, exports: fakeDb };

const pricebook = require('../server/pricebook');
const views = require('../server/views');

function reset() {
  state.items = [];
  state.nextId = 1;
}

(async () => {
  // 1. Add + list: alphabetical, scoped to the company.
  reset();
  await pricebook.addItem(1, { name: 'Panic bar', part_number: '98E', description: 'Von Duprin exit device', cost_cents: 4599 });
  await pricebook.addItem(1, { name: 'Hinge', part_number: '', description: '', cost_cents: 1250 });
  await pricebook.addItem(2, { name: 'Other co part', part_number: null, description: null, cost_cents: 100 });
  const list = await pricebook.listItems(1);
  assert.deepStrictEqual(list.map((x) => x.name), ['Hinge', 'Panic bar']);
  assert.strictEqual((await pricebook.listItems(2)).length, 1);
  assert.strictEqual(list[1].cost_cents, 4599);

  // 2. Search matches name, part number, and description; misses return none.
  assert.strictEqual((await pricebook.listItems(1, 'panic')).length, 1);
  assert.strictEqual((await pricebook.listItems(1, '98E')).length, 1);
  assert.strictEqual((await pricebook.listItems(1, 'exit device')).length, 1);
  assert.strictEqual((await pricebook.listItems(1, 'nope')).length, 0);

  // 3. Update changes the row; another company cannot update it.
  const updated = await pricebook.updateItem(1, 1, { name: 'Panic bar', part_number: '98E', description: 'Von Duprin exit device', cost_cents: 4700 });
  assert.strictEqual(updated.cost_cents, 4700);
  await assert.rejects(() => pricebook.updateItem(2, 1, { name: 'X', part_number: null, description: null, cost_cents: 1 }), /Part not found/);
  await assert.rejects(() => pricebook.updateItem(1, 999, { name: 'X', part_number: null, description: null, cost_cents: 1 }), /Part not found/);

  // 4. Delete removes the row; deleting again throws.
  await pricebook.deleteItem(1, 2);
  assert.strictEqual((await pricebook.listItems(1)).length, 1);
  await assert.rejects(() => pricebook.deleteItem(1, 2), /Part not found/);

  // 5. Validation: name is required, cost must be a whole number of cents >= 0.
  await assert.rejects(() => pricebook.addItem(1, { name: '   ', part_number: null, description: null, cost_cents: 100 }), /Part name is required/);
  await assert.rejects(() => pricebook.addItem(1, { name: 'X', part_number: null, description: null, cost_cents: -5 }), /Cost must be \$0 or more/);
  await assert.rejects(() => pricebook.addItem(1, { name: 'X', part_number: null, description: null, cost_cents: 10.5 }), /Cost must be \$0 or more/);

  // 6. The page shows saved parts with labeled, full-width fields —
  // the old one-line row squeezed name/description to a character wide.
  {
    const page = views.priceBookPage({ user: { role: 'owner' }, sub: { status: 'active' }, company: { name: 'Handyman Co' }, flash: null, items: [{ id: 1, name: 'Faucet supply line', part_number: '001', description: 'Braided stainless', cost_cents: 695 }], query: '' });
    assert.ok(page.includes('Faucet supply line'), 'price book hides the part name');
    assert.ok(page.includes('Braided stainless'), 'price book hides the description');
    assert.ok(page.includes('<label>Name'), 'saved part name has no label');
    assert.ok(page.includes('<label>Description'), 'saved part description has no label');
    assert.ok(!page.includes('width:130px'), 'saved part row still uses the cramped fixed widths');
    assert.ok(!page.includes('width:90px'), 'saved part row still uses the cramped fixed widths');
  }

  console.log('pricebook.test.js PASS');
})().catch((e) => {
  console.error('pricebook.test.js FAIL:', e);
  process.exit(1);
});
