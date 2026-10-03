'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { generate, toNdjson } = require('../gen');
const { tmpdir, runCli } = require('./helpers');

function setup() {
  const dir = tmpdir('resume');
  const { a, b } = generate(23, 60);
  fs.writeFileSync(path.join(dir, 'a.ndjson'), toNdjson(a));
  fs.writeFileSync(path.join(dir, 'b.ndjson'), toNdjson(b));
  return dir;
}

function certificateIds(out) {
  return JSON.parse(fs.readFileSync(path.join(out, 'conflict.json'), 'utf8'))
    .conflicts.map((c) => c.id);
}

// Acceptance 2a: crash BEFORE writing the conflict certificate, then resume.
test('crash before writing conflict certificate, resume completes without duplicates', () => {
  const dir = setup();
  const out = path.join(dir, 'out');
  const args = ['merge', path.join(dir, 'a.ndjson'), path.join(dir, 'b.ndjson'), '--out', out];

  const crashed = runCli(args, { SYNC_CRASH: 'pre-conflicts' });
  assert.equal(crashed.status, 2);
  assert.ok(!fs.existsSync(path.join(out, 'conflict.json')), 'conflict.json must not exist yet');
  assert.ok(fs.existsSync(path.join(out, 'log.ndjson')), 'earlier steps completed');

  const resumed = runCli(args);
  assert.equal(resumed.status, 0, resumed.stderr);
  const ids = certificateIds(out);
  assert.equal(new Set(ids).size, ids.length, 'duplicate certificates after resume');
  assert.ok(ids.length > 0, 'expected some conflicts from generated sources');
});

// Acceptance 2b: crash AFTER writing the certificate but BEFORE journaling,
// then resume; the rewrite must be idempotent (no duplicate certificates).
test('crash after writing conflict certificate, resume does not duplicate certificates', () => {
  const dir = setup();
  const out = path.join(dir, 'out');
  const args = ['merge', path.join(dir, 'a.ndjson'), path.join(dir, 'b.ndjson'), '--out', out];

  const crashed = runCli(args, { SYNC_CRASH: 'post-conflicts' });
  assert.equal(crashed.status, 2);
  assert.ok(fs.existsSync(path.join(out, 'conflict.json')), 'certificate file was written');
  const journal = fs.readFileSync(path.join(out, '.journal'), 'utf8');
  assert.ok(!journal.includes('conflicts'), 'journal must not record the conflicts step yet');
  const idsAfterCrash = certificateIds(out);

  const resumed = runCli(args);
  assert.equal(resumed.status, 0, resumed.stderr);
  const ids = certificateIds(out);
  assert.deepEqual(ids.sort(), idsAfterCrash.sort());
  assert.equal(new Set(ids).size, ids.length, 'duplicate certificates after resume');

  // Final state must equal a clean (never-crashed) run.
  const cleanOut = path.join(dir, 'clean');
  const clean = runCli(['merge', path.join(dir, 'a.ndjson'), path.join(dir, 'b.ndjson'), '--out', cleanOut]);
  assert.equal(clean.status, 0, clean.stderr);
  for (const f of ['log.ndjson', 'balance.json', 'conflict.json']) {
    assert.equal(
      fs.readFileSync(path.join(out, f), 'utf8'),
      fs.readFileSync(path.join(cleanOut, f), 'utf8'),
      `${f} differs from clean run`
    );
  }
});
