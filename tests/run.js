'use strict';
// Minimal test runner: each test file runs in its own process (so env vars
// and require-cache fakes never leak between suites). Usage: node tests/run.js
const { spawnSync } = require('node:child_process');
const path = require('node:path');

const files = ['tiers.test.js', 'billing-tiers.test.js', 'views-tiers.test.js', 'views-dispatch.test.js'];
if (process.env.RISE_TEST_DATABASE_URL) files.push('http-tiers.test.js', 'http-dispatch.test.js');

let passed = 0;
for (const f of files) {
  const r = spawnSync(process.execPath, [path.join(__dirname, f)], { stdio: 'inherit', env: process.env });
  if (r.status === 0) passed += 1;
  else console.error(`FAILED: ${f}`);
}
console.log(`\n${passed}/${files.length} suites passed.`);
process.exit(passed === files.length ? 0 : 1);
