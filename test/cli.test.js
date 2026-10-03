'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { run } = require('../cli');

function invoke(args) {
  const lines = [];
  const code = run(args, (line) => lines.push(line));
  assert.equal(lines.length, 1, 'expected exactly one output line');
  return { code, json: JSON.parse(lines[0]) };
}

test('CLI: freeze, merge, release, position, cert end to end', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'margin-cli-'));
  const s1 = path.join(dir, 's1.json');
  const s2 = path.join(dir, 's2.json');

  assert.equal(invoke(['--state', s1, 'credit', 'c1', 'ACME', '100']).code, 0);
  assert.equal(invoke(['--state', s2, 'credit', 'c1', 'ACME', '100']).code, 0);

  const f1 = invoke(['--state', s1, 'freeze', 'e1', 'ACME', '40']);
  assert.equal(f1.code, 0);
  assert.equal(f1.json.available, 60);

  const f2 = invoke(['--state', s2, 'freeze', 'e2', 'ACME', '30']);
  assert.equal(f2.code, 0);
  assert.equal(f2.json.available, 70);

  const merged = invoke(['--state', s1, 'merge', s2]);
  assert.equal(merged.code, 0);
  assert.equal(merged.json[0].available, 30);
  assert.deepEqual(merged.json[0].frozen.map((f) => f.freezeId), ['e1', 'e2']);

  const r1 = invoke(['--state', s1, 'release', 'r1', 'e1', '15']);
  assert.equal(r1.code, 0);
  assert.equal(r1.json.available, 45);

  // Duplicate release event id is idempotent.
  const r1dup = invoke(['--state', s1, 'release', 'r1', 'e1', '15']);
  assert.equal(r1dup.code, 0);
  assert.equal(r1dup.json.available, 45);

  const r2 = invoke(['--state', s1, 'release', 'r2', 'e1', '25']);
  assert.equal(r2.code, 0);
  assert.equal(r2.json.available, 70);
  assert.deepEqual(r2.json.tombstones.map((t) => [t.freezeId, t.released]), [['e1', 40]]);

  const pos = invoke(['--state', s1, 'position', 'ACME']);
  assert.equal(pos.code, 0);
  assert.equal(pos.json.symbol, 'ACME');
  assert.equal(pos.json.available, 70);
  assert.equal(pos.json.frozen.length, 1);
  assert.equal(pos.json.tombstones.length, 1);

  const cert = invoke(['--state', s1, 'cert', 'ACME']);
  assert.equal(cert.code, 0);
  assert.equal(cert.json.symbol, 'ACME');
  assert.equal(cert.json.available, 70);
  assert.ok(Array.isArray(cert.json.frozen));
  assert.match(cert.json.releaseHash, /^[0-9a-f]{64}$/);

  const certAll = invoke(['--state', s1, 'cert']);
  assert.equal(certAll.code, 0);
  assert.ok(Array.isArray(certAll.json));
});

test('CLI: error codes are JSON with exit code 1', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'margin-cli-err-'));
  const s1 = path.join(dir, 's1.json');

  invoke(['--state', s1, 'credit', 'c1', 'ACME', '50']);
  invoke(['--state', s1, 'freeze', 'e1', 'ACME', '20']);

  const over = invoke(['--state', s1, 'release', 'r1', 'e1', '21']);
  assert.equal(over.code, 1);
  assert.deepEqual(over.json, { error: 'over-release' });

  const unknown = invoke(['--state', s1, 'release', 'r2', 'nope', '1']);
  assert.equal(unknown.code, 1);
  assert.deepEqual(unknown.json, { error: 'unknown-freeze' });

  const insufficient = invoke(['--state', s1, 'freeze', 'e2', 'ACME', '31']);
  assert.equal(insufficient.code, 1);
  assert.deepEqual(insufficient.json, { error: 'insufficient-margin' });

  const conflict = invoke(['--state', s1, 'freeze', 'e1', 'ACME', '21']);
  assert.equal(conflict.code, 1);
  assert.deepEqual(conflict.json, { error: 'event-conflict' });

  // State file must be unchanged after failed commands.
  const pos = invoke(['--state', s1, 'position', 'ACME']);
  assert.equal(pos.json.available, 30);
  assert.equal(pos.json.frozen.length, 1);
});
