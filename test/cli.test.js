'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const CLI = path.join(__dirname, '..', 'src', 'cli.js');

function tmpdir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'recipe-cli-'));
}

function runCli(args) {
  return spawnSync(process.execPath, [CLI, ...args], { encoding: 'utf8' });
}

test('run produces versioned result with values, status, invalid, diff, certificates', () => {
  const dir = tmpdir();
  const input = path.join(dir, 'commands.json');
  const output = path.join(dir, 'result.json');
  fs.writeFileSync(input, JSON.stringify({
    commands: [
      { op: 'upsert', tag: 'a', type: 'const', value: 2 },
      { op: 'upsert', tag: 'b', type: 'formula', expr: 'a * 10' },
      { op: 'upsert', tag: 'c', type: 'formula', expr: 'b / 4' },
      { op: 'set', tag: 'a', value: 3 },
      { op: 'commit' },
      { op: 'upsert', tag: 'a', type: 'formula', expr: 'c - b' },
      { op: 'undo' },
    ],
  }));

  const proc = runCli(['run', input, '-o', output]);
  assert.equal(proc.status, 0, `stderr: ${proc.stderr}`);

  const result = JSON.parse(fs.readFileSync(output, 'utf8'));
  assert.equal(result.versions.length, 7);
  assert.deepEqual(result.versions.map((v) => v.version), [1, 2, 3, 4, 5, 6, 7]);

  // version 4: set a=3 propagates through b and c
  const v4 = result.versions[3];
  assert.equal(v4.status, 'ok');
  assert.deepEqual(v4.values, { a: 3, b: 30, c: 7.5 });
  assert.deepEqual(v4.invalid, []);
  assert.deepEqual(v4.diff, { a: { from: 2, to: 3 }, b: { from: 20, to: 30 }, c: { from: 5, to: 7.5 } });
  assert.deepEqual(v4.recomputed, ['a', 'b', 'c']);

  // every version carries a certificate with seq, topo, hash
  for (const v of result.versions) {
    assert.equal(v.certificate.seq, v.version);
    assert.ok(Array.isArray(v.certificate.topo));
    assert.match(v.certificate.hash, /^[0-9a-f]{64}$/);
  }
  // deterministic topo order, tie-broken by tag name
  assert.deepEqual(v4.certificate.topo, ['a', 'b', 'c']);

  // commit is a checkpoint: empty diff, same state
  const v5 = result.versions[4];
  assert.deepEqual(v5.diff, {});
  assert.deepEqual(v5.values, v4.values);

  // version 6: cycle a -> c -> b -> a invalidates the whole chain
  const v6 = result.versions[5];
  assert.equal(v6.status, 'invalid');
  assert.deepEqual(v6.invalid, ['a', 'b', 'c']);
  assert.deepEqual(v6.values, {});

  // version 7: undo restores the pre-cycle topology and values
  const v7 = result.versions[6];
  assert.equal(v7.status, 'ok');
  assert.deepEqual(v7.values, { a: 3, b: 30, c: 7.5 });
  assert.equal(v7.certificate.hash, v5.certificate.hash,
    'undo must restore the identical certified state');

  // final summary mirrors the last version
  assert.equal(result.final.version, 7);
  assert.deepEqual(result.final.values, { a: 3, b: 30, c: 7.5 });
});

test('invalid JSON input exits 1 with {error, code, message}', () => {
  const dir = tmpdir();
  const input = path.join(dir, 'commands.json');
  fs.writeFileSync(input, '{ not json');
  const proc = runCli(['run', input, '-o', path.join(dir, 'out.json')]);
  assert.equal(proc.status, 1);
  const err = JSON.parse(proc.stdout);
  assert.equal(err.error, true);
  assert.equal(err.code, 'E_INPUT');
  assert.equal(typeof err.message, 'string');
});

test('unreadable commands file exits 1 with {error, code, message}', () => {
  const dir = tmpdir();
  const proc = runCli(['run', path.join(dir, 'missing.json'), '-o', path.join(dir, 'out.json')]);
  assert.equal(proc.status, 1);
  const err = JSON.parse(proc.stdout);
  assert.equal(err.error, true);
  assert.equal(err.code, 'E_INPUT');
  assert.ok(err.message.length > 0);
});

test('bad formula in a command exits 1 with error object', () => {
  const dir = tmpdir();
  const input = path.join(dir, 'commands.json');
  fs.writeFileSync(input, JSON.stringify({
    commands: [{ op: 'upsert', tag: 'x', type: 'formula', expr: '1 +' }],
  }));
  const proc = runCli(['run', input, '-o', path.join(dir, 'out.json')]);
  assert.equal(proc.status, 1);
  const err = JSON.parse(proc.stdout);
  assert.equal(err.error, true);
  assert.equal(err.code, 'E_FORMULA');
});

test('division by zero and unknown deps invalidate only their branch via CLI', () => {
  const dir = tmpdir();
  const input = path.join(dir, 'commands.json');
  const output = path.join(dir, 'result.json');
  fs.writeFileSync(input, JSON.stringify({
    commands: [
      { op: 'upsert', tag: 'n', type: 'const', value: 8 },
      { op: 'upsert', tag: 'd', type: 'const', value: 0 },
      { op: 'upsert', tag: 'ratio', type: 'formula', expr: 'n / d' },
      { op: 'upsert', tag: 'ratio2', type: 'formula', expr: 'ratio * 2' },
      { op: 'upsert', tag: 'mystery', type: 'formula', expr: 'ghost + 1' },
      { op: 'upsert', tag: 'safe', type: 'formula', expr: 'n * 2' },
      { op: 'set', tag: 'd', value: 4 },
    ],
  }));
  const proc = runCli(['run', input, '-o', output]);
  assert.equal(proc.status, 0, `stderr: ${proc.stderr}`);
  const result = JSON.parse(fs.readFileSync(output, 'utf8'));

  const v6 = result.versions[5];
  assert.deepEqual(v6.invalid, ['mystery', 'ratio', 'ratio2']);
  assert.deepEqual(v6.values, { d: 0, n: 8, safe: 16 }, 'unrelated branch unpolluted');

  const v7 = result.versions[6];
  assert.deepEqual(v7.invalid, ['mystery'], 'div-zero branch recovers, unknown dep stays');
  assert.deepEqual(v7.values, { d: 4, n: 8, ratio: 2, ratio2: 4, safe: 16 });
  assert.deepEqual(v7.recomputed, ['d', 'ratio', 'ratio2']);
});
