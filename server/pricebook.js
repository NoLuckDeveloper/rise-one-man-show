'use strict';
// Price book: the parts catalog each company builds for itself. One row
// per part (name, optional part number, optional description, cost in
// cents). Every function scopes by company_id, so a company can only ever
// see and change its own parts. Job reports pick from the book; the
// invoice treats a picked part exactly like a hand-typed one (stored cost
// x the company's parts multiplier).
const { q, one, many } = require('./db');

function cleanText(v) {
  const s = String(v || '').trim();
  return s ? s : null;
}

function cleanCost(v) {
  const n = Number(v);
  if (!Number.isFinite(n) || n < 0 || !Number.isInteger(n)) {
    throw new Error('Cost must be $0 or more.');
  }
  return n;
}

function cleanFields({ name, part_number, description, cost_cents }) {
  const cleanName = String(name || '').trim();
  if (!cleanName) throw new Error('Part name is required.');
  return {
    name: cleanName,
    part_number: cleanText(part_number),
    description: cleanText(description),
    cost_cents: cleanCost(cost_cents),
  };
}

// All items for a company, alphabetical; with a search term, matches
// name, part number, or description.
async function listItems(companyId, query) {
  const term = String(query || '').trim();
  if (term) {
    const like = `%${term}%`;
    return many(
      `SELECT * FROM price_book_items WHERE company_id = $1
        AND (name ILIKE $2 OR part_number ILIKE $2 OR description ILIKE $2)
       ORDER BY name ASC`,
      [companyId, like]
    );
  }
  return many('SELECT * FROM price_book_items WHERE company_id = $1 ORDER BY name ASC', [companyId]);
}

async function addItem(companyId, fields) {
  const c = cleanFields(fields);
  return one(
    `INSERT INTO price_book_items (company_id, name, part_number, description, cost_cents)
     VALUES ($1, $2, $3, $4, $5) RETURNING *`,
    [companyId, c.name, c.part_number, c.description, c.cost_cents]
  );
}

async function updateItem(companyId, id, fields) {
  const c = cleanFields(fields);
  const row = await one(
    `UPDATE price_book_items
        SET name = $3, part_number = $4, description = $5, cost_cents = $6, updated_at = now()
      WHERE company_id = $1 AND id = $2 RETURNING *`,
    [companyId, id, c.name, c.part_number, c.description, c.cost_cents]
  );
  if (!row) throw new Error('Part not found.');
  return row;
}

async function deleteItem(companyId, id) {
  const res = await q('DELETE FROM price_book_items WHERE company_id = $1 AND id = $2', [companyId, id]);
  if (!res || res.rowCount === 0) throw new Error('Part not found.');
}

module.exports = { listItems, addItem, updateItem, deleteItem };
