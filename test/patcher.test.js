'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const CLI = path.join(__dirname, '..', 'cli.js');

const BASE_STATE = {
  version: 0,
  attributes: { env: 'prod' },
  files: { 'a.txt': 'alpha' },
  chain: ['genesis'],
};

// Three ops, none dangerous: add attr, add file, extend evidence chain.
const OPS = [
  { op: 'set-attr', path: 'reviewer', value: 'alice', expectVersion: 0 },
  { op: 'put-file', path: 'b.txt', value: 'bravo', expectVersion: 1 },
  { op: 'append-chain', entry: 'sealed-by-alice', expectVersion: 2 },
];

const PATCHED_STATE = {
  version: 3,
  attributes: { env: 'prod', reviewer: 'alice' },
  files: { 'a.txt': 'alpha', 'b.txt': 'bravo' },
  chain: ['genesis', 'sealed-by-alice'],
};

function makePkg() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'evidence-pkg-'));
  fs.writeFileSync(path.join(dir, 'state.json'), JSON.stringify(BASE_STATE, null, 2) + '\n');
  return dir;
}

function writePatch(dir, ops) {
  const file = path.join(dir, 'patch.json');
  fs.writeFileSync(file, JSON.stringify({ ops }));
  return file;
}

function runCli(args) {
  return spawnSync(process.execPath, [CLI, ...args], { encoding: 'utf8' });
}

function readState(dir) {
  return JSON.parse(fs.readFileSync(path.join(dir, 'state.json'), 'utf8'));
}

function rawState(dir) {
  return fs.readFileSync(path.join(dir, 'state.json'), 'utf8');
}

function leftoverArtifacts(dir) {
  return fs.readdirSync(dir).filter((name) => name.endsWith('.tmp') || name === 'journal.json');
}

test('full commit applies all ops and leaves no journal or temp files', () => {
  const dir = makePkg();
  const res = runCli(['apply', '--pkg', dir, '--patch', writePatch(dir, OPS)]);
  assert.equal(res.status, 0, res.stderr);
  assert.deepEqual(readState(dir), PATCHED_STATE);
  assert.deepEqual(leftoverArtifacts(dir), []);
});

test('crash at every failure point recovers to a deterministic state', () => {
  for (let failAt = 1; failAt <= OPS.length + 1; failAt++) {
    const dir = makePkg();
    const crashed = runCli(['apply', '--pkg', dir, '--patch', writePatch(dir, OPS), `--fail-at=${failAt}`]);
    assert.equal(crashed.status, 2, `fail-at=${failAt}: expected simulated crash, got ${crashed.status}`);
    assert.ok(fs.existsSync(path.join(dir, 'journal.json')), `fail-at=${failAt}: journal must survive the crash`);

    const recovered = runCli(['recover', '--pkg', dir]);
    assert.equal(recovered.status, 0, `fail-at=${failAt}: ${recovered.stderr}`);

    // fail-at < op count -> roll back to pre-commit; otherwise roll forward.
    const expected = failAt < OPS.length ? BASE_STATE : PATCHED_STATE;
    assert.deepEqual(readState(dir), expected, `fail-at=${failAt}: wrong recovered state`);
    assert.deepEqual(leftoverArtifacts(dir), [], `fail-at=${failAt}: temp files or journal left behind`);
  }
});

test('rolled-back state is byte-identical to the pre-commit state', () => {
  const dir = makePkg();
  const before = rawState(dir);
  runCli(['apply', '--pkg', dir, '--patch', writePatch(dir, OPS), '--fail-at=2']);
  runCli(['recover', '--pkg', dir]);
  assert.equal(rawState(dir), before);
});

test('dangerous op with explicit inverse rolls back via that inverse', () => {
  const dir = makePkg();
  const ops = [
    { op: 'delete-file', path: 'a.txt', expectVersion: 0, inverse: { op: 'put-file', path: 'a.txt', value: 'alpha' } },
    { op: 'set-attr', path: 'env', value: 'staging', expectVersion: 1, inverse: { op: 'set-attr', path: 'env', value: 'prod' } },
  ];
  const crashed = runCli(['apply', '--pkg', dir, '--patch', writePatch(dir, ops), '--fail-at=1']);
  assert.equal(crashed.status, 2);
  const recovered = runCli(['recover', '--pkg', dir]);
  assert.equal(recovered.status, 0, recovered.stderr);
  assert.deepEqual(readState(dir), BASE_STATE);
  assert.deepEqual(leftoverArtifacts(dir), []);
});

test('dangerous op with inverse commits cleanly when there is no crash', () => {
  const dir = makePkg();
  const ops = [
    { op: 'delete-attr', path: 'env', expectVersion: 0, inverse: { op: 'set-attr', path: 'env', value: 'prod' } },
  ];
  const res = runCli(['apply', '--pkg', dir, '--patch', writePatch(dir, ops)]);
  assert.equal(res.status, 0, res.stderr);
  assert.deepEqual(readState(dir), { version: 1, attributes: {}, files: { 'a.txt': 'alpha' }, chain: ['genesis'] });
  assert.deepEqual(leftoverArtifacts(dir), []);
});

test('illegal patches are rejected with exit code 1 and touch nothing on disk', () => {
  const cases = [
    ['unknown op', [{ op: 'nuke', expectVersion: 0 }]],
    ['conditional version mismatch', [{ op: 'set-attr', path: 'x', value: 1, expectVersion: 5 }]],
    ['stale version on second op', [OPS[0], { op: 'put-file', path: 'b.txt', value: 'x', expectVersion: 0 }]],
    ['delete-file without inverse', [{ op: 'delete-file', path: 'a.txt', expectVersion: 0 }]],
    ['overwrite attr without inverse', [{ op: 'set-attr', path: 'env', value: 'x', expectVersion: 0 }]],
    ['overwrite file without inverse', [{ op: 'put-file', path: 'a.txt', value: 'x', expectVersion: 0 }]],
    ['delete missing file', [{ op: 'delete-file', path: 'nope.txt', expectVersion: 0, inverse: { op: 'put-file', path: 'nope.txt', value: '' } }]],
    ['unknown inverse op', [{ op: 'delete-file', path: 'a.txt', expectVersion: 0, inverse: { op: 'nuke' } }]],
  ];
  for (const [name, ops] of cases) {
    const dir = makePkg();
    const before = rawState(dir);
    const res = runCli(['apply', '--pkg', dir, '--patch', writePatch(dir, ops)]);
    assert.equal(res.status, 1, `${name}: expected exit 1, got ${res.status} (${res.stdout}${res.stderr})`);
    assert.equal(rawState(dir), before, `${name}: state.json must be untouched`);
    assert.deepEqual(leftoverArtifacts(dir), [], `${name}: nothing may be written to disk`);
  }
});

test('recover without a journal is a no-op with exit code 0', () => {
  const dir = makePkg();
  const res = runCli(['recover', '--pkg', dir]);
  assert.equal(res.status, 0, res.stderr);
  assert.deepEqual(readState(dir), BASE_STATE);
  assert.deepEqual(leftoverArtifacts(dir), []);
});

test('apply auto-recovers a leftover journal before committing a new patch', () => {
  const dir = makePkg();
  runCli(['apply', '--pkg', dir, '--patch', writePatch(dir, OPS), '--fail-at=1']);
  const res = runCli(['apply', '--pkg', dir, '--patch', writePatch(dir, OPS)]);
  assert.equal(res.status, 0, res.stderr);
  assert.deepEqual(readState(dir), PATCHED_STATE);
  assert.deepEqual(leftoverArtifacts(dir), []);
});
