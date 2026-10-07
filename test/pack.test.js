'use strict';

// Acceptance 3: truncating the last half-written record and restarting
// recovers the previous complete pack.
// Acceptance 4: rollback to a nonexistent version fails and keeps state.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const pack = require('../lib/pack');
const { Engine, AuditError } = require('../lib/engine');

const RULES_V1 = [{ id: 'r1', pattern: 'a(b|c)*', alphabet: ['a', 'b', 'c'] }];
const RULES_V2 = [
  { id: 'r1', pattern: 'a(b|c)*', alphabet: ['a', 'b', 'c'] },
  { id: 'r2', pattern: '~(a*)&(a|b)*', alphabet: ['a', 'b'] },
];

function tmpdir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'audit-pack-'));
}

test('torn tail is truncated and previous complete pack recovered', () => {
  const dir = tmpdir();
  const file = path.join(dir, 'rules.pack');
  pack.appendPack(file, RULES_V1);
  pack.appendPack(file, RULES_V2);

  // Simulate a crash halfway through appending a third record.
  const third = pack.encodeRecord({ type: 'pack', version: 3, rules: RULES_V2 });
  const half = third.slice(0, Math.floor(third.length / 2));
  fs.appendFileSync(file, half);
  const sizeBefore = fs.statSync(file).size;

  // Restart: a fresh engine loads the pack.
  const engine = new Engine();
  const [line] = engine.exec({ op: 'loadPack', path: file });
  const info = JSON.parse(line.slice(4));
  assert.equal(info.versions, 2);
  assert.equal(info.current, 2);
  assert.equal(info.truncated, true);

  // The bad tail is physically removed.
  assert.ok(fs.statSync(file).size < sizeBefore);
  assert.equal(fs.statSync(file).size, sizeBefore - half.length);

  // Rules come from the last complete version.
  const rules = engine.currentRules();
  assert.deepEqual(rules, RULES_V2);

  // Recovery is idempotent: loading again reports a clean file.
  const again = pack.loadPack(file);
  assert.equal(again.truncated, false);
  assert.equal(again.versions.length, 2);
});

test('single truncated record falls back to the previous pack', () => {
  const dir = tmpdir();
  const file = path.join(dir, 'rules.pack');
  pack.appendPack(file, RULES_V1);
  const goodSize = fs.statSync(file).size;
  fs.appendFileSync(file, pack.encodeRecord({ type: 'pack', version: 2, rules: RULES_V2 }).slice(0, 17));

  const engine = new Engine();
  engine.exec({ op: 'loadPack', path: file });
  assert.equal(engine.packState.current, 1);
  assert.deepEqual(engine.currentRules(), RULES_V1);
  assert.equal(fs.statSync(file).size, goodSize);
});

test('CRC mismatch on a complete record is a hard error', () => {
  const dir = tmpdir();
  const file = path.join(dir, 'rules.pack');
  pack.appendPack(file, RULES_V1);
  pack.appendPack(file, RULES_V2);
  // Corrupt one byte inside the first (complete) record.
  const buf = fs.readFileSync(file);
  buf[20] = buf[20] === 65 ? 66 : 65;
  fs.writeFileSync(file, buf);

  assert.throws(() => pack.loadPack(file), (e) => {
    assert.equal(e.code, 'CRC_FAILED');
    assert.equal(e.exitCode, 5);
    return true;
  });
});

test('rollback to a nonexistent version errors and keeps state', () => {
  const dir = tmpdir();
  const file = path.join(dir, 'rules.pack');
  pack.appendPack(file, RULES_V1);
  pack.appendPack(file, RULES_V2);
  const bytesBefore = fs.readFileSync(file);

  const engine = new Engine();
  engine.exec({ op: 'loadPack', path: file });
  engine.exec({ op: 'rollback', version: 1 });
  assert.equal(engine.packState.current, 1);

  assert.throws(() => engine.exec({ op: 'rollback', version: 99 }), (e) => {
    assert.ok(e instanceof AuditError);
    assert.equal(e.code, 'UNKNOWN_VERSION');
    assert.equal(e.exitCode, 5);
    return true;
  });
  // State and on-disk file are both unchanged.
  assert.equal(engine.packState.current, 1);
  assert.deepEqual(engine.currentRules(), RULES_V1);
  assert.deepEqual(fs.readFileSync(file), bytesBefore);

  // Legal rollback still works afterwards.
  engine.exec({ op: 'rollback', version: 2 });
  assert.deepEqual(engine.currentRules(), RULES_V2);
});

test('loadPack on a missing file reports UNKNOWN_PACK', () => {
  const engine = new Engine();
  assert.throws(() => engine.exec({ op: 'loadPack', path: '/nonexistent/x.pack' }), (e) => {
    assert.equal(e.code, 'UNKNOWN_PACK');
    assert.equal(e.exitCode, 5);
    return true;
  });
});
