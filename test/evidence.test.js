'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const CLI = path.join(__dirname, '..', 'cli.js');

function makeDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'evidence-'));
}

// NOTE: this sandboxed environment swallows grandchild process output that
// goes to pipes, so capture stdout/stderr via temp files instead.
function runCli(args) {
  const captureDir = fs.mkdtempSync(path.join(os.tmpdir(), 'evidence-cap-'));
  const outFile = path.join(captureDir, 'stdout');
  const errFile = path.join(captureDir, 'stderr');
  const outFd = fs.openSync(outFile, 'w');
  const errFd = fs.openSync(errFile, 'w');
  let result;
  try {
    result = spawnSync(process.execPath, [CLI, ...args], {
      stdio: ['ignore', outFd, errFd],
    });
  } finally {
    fs.closeSync(outFd);
    fs.closeSync(errFd);
  }
  return {
    status: result.status,
    stdout: fs.readFileSync(outFile, 'utf8'),
    stderr: fs.readFileSync(errFile, 'utf8'),
  };
}

function writePatch(dir, patch) {
  const file = path.join(dir, 'patch.json');
  fs.writeFileSync(file, JSON.stringify(patch));
  return file;
}

function readState(dir) {
  return JSON.parse(fs.readFileSync(path.join(dir, 'state.json'), 'utf8'));
}

function readJournal(dir) {
  return JSON.parse(fs.readFileSync(path.join(dir, 'journal.json'), 'utf8'));
}

function tempFiles(dir) {
  return fs.readdirSync(dir).filter((entry) => entry.endsWith('.tmp'));
}

// A 3-op patch where every op carries an inverse -> recovery must roll back.
function invertiblePatch(baseVersion) {
  return {
    ops: [
      {
        type: 'set-attr',
        expectVersion: baseVersion,
        key: 'severity',
        value: 'high',
        inverse: { type: 'delete-attr', key: 'severity' },
      },
      {
        type: 'put-file',
        expectVersion: baseVersion + 1,
        path: 'reports/summary.txt',
        content: 'summary v1',
        inverse: { type: 'delete-file', path: 'reports/summary.txt' },
      },
      {
        type: 'append-chain',
        expectVersion: baseVersion + 2,
        entry: { actor: 'analyst', action: 'seal' },
        inverse: { type: 'set-attr', key: '_noop', value: null },
      },
    ],
  };
}

// A 3-op patch whose first op has no inverse -> recovery must roll forward.
function nonInvertiblePatch(baseVersion) {
  return {
    ops: [
      { type: 'set-attr', expectVersion: baseVersion, key: 'locked', value: true },
      {
        type: 'put-file',
        expectVersion: baseVersion + 1,
        path: 'logs/audit.log',
        content: 'audit entry',
        inverse: { type: 'delete-file', path: 'logs/audit.log' },
      },
      {
        type: 'append-chain',
        expectVersion: baseVersion + 2,
        entry: { actor: 'system', action: 'lock' },
        inverse: { type: 'set-attr', key: '_noop', value: null },
      },
    ],
  };
}

function fullyAppliedState(base, patch) {
  const state = JSON.parse(JSON.stringify(base));
  for (const op of patch.ops) {
    if (op.type === 'set-attr') state.attributes[op.key] = op.value;
    if (op.type === 'delete-attr') delete state.attributes[op.key];
    if (op.type === 'put-file') state.files[op.path] = op.content;
    if (op.type === 'delete-file') delete state.files[op.path];
    if (op.type === 'append-chain') state.chain.push(op.entry);
    state.version += 1;
  }
  return state;
}

test('full commit: all ops applied, journal committed, outputs present', () => {
  const dir = makeDir();
  assert.equal(runCli(['init', dir]).status, 0);
  const base = readState(dir);
  const patch = invertiblePatch(base.version);
  const patchFile = writePatch(dir, patch);

  const result = runCli(['apply', dir, patchFile]);
  assert.equal(result.status, 0, result.stderr);

  assert.deepEqual(readState(dir), fullyAppliedState(base, patch));
  const journal = readJournal(dir);
  assert.equal(journal.status, 'committed');
  assert.equal(journal.completed, 3);
  assert.deepEqual(tempFiles(dir), []);
});

test('crash at every op then recover: rollback when all ops invertible', () => {
  for (let failAt = 1; failAt <= 3; failAt += 1) {
    const dir = makeDir();
    runCli(['init', dir]);
    const base = readState(dir);
    const patchFile = writePatch(dir, invertiblePatch(base.version));

    const crashed = runCli(['apply', dir, patchFile, `--fail-at=${failAt}`]);
    assert.equal(crashed.status, 2, `fail-at=${failAt} should exit 2`);
    assert.equal(readJournal(dir).status, 'pending');

    const recovered = runCli(['recover', dir]);
    assert.equal(recovered.status, 0, recovered.stderr);
    assert.match(recovered.stdout, /rolled-back/);

    assert.deepEqual(readState(dir), base, `fail-at=${failAt}: state must equal pre-commit`);
    assert.equal(readJournal(dir).status, 'rolled-back');
    assert.deepEqual(tempFiles(dir), [], `fail-at=${failAt}: no temp files after recovery`);
  }
});

test('crash at every op then recover: roll forward when an applied op lacks inverse', () => {
  for (let failAt = 1; failAt <= 3; failAt += 1) {
    const dir = makeDir();
    runCli(['init', dir]);
    const base = readState(dir);
    const patch = nonInvertiblePatch(base.version);
    const patchFile = writePatch(dir, patch);

    const crashed = runCli(['apply', dir, patchFile, `--fail-at=${failAt}`]);
    assert.equal(crashed.status, 2, `fail-at=${failAt} should exit 2`);

    const recovered = runCli(['recover', dir]);
    assert.equal(recovered.status, 0, recovered.stderr);
    assert.match(recovered.stdout, /rolled-forward/);

    assert.deepEqual(
      readState(dir),
      fullyAppliedState(base, patch),
      `fail-at=${failAt}: state must equal fully applied patch`
    );
    assert.equal(readJournal(dir).status, 'committed');
    assert.deepEqual(tempFiles(dir), [], `fail-at=${failAt}: no temp files after recovery`);
  }
});

test('restart auto-recovers from journal before next apply', () => {
  const dir = makeDir();
  runCli(['init', dir]);
  const base = readState(dir);
  const patchFile = writePatch(dir, invertiblePatch(base.version));

  const crashed = runCli(['apply', dir, patchFile, '--fail-at=2']);
  assert.equal(crashed.status, 2);

  // A fresh process auto-recovers (rolls back) before applying the next patch.
  const next = runCli(['apply', dir, patchFile]);
  assert.equal(next.status, 0, next.stderr);
  assert.deepEqual(readState(dir), fullyAppliedState(base, invertiblePatch(base.version)));
  assert.deepEqual(tempFiles(dir), []);
});

test('unknown op type is rejected with exit 1 and nothing is persisted', () => {
  const dir = makeDir();
  runCli(['init', dir]);
  const before = readState(dir);
  const patchFile = writePatch(dir, {
    ops: [{ type: 'nuke-everything', expectVersion: 0 }],
  });

  const result = runCli(['apply', dir, patchFile]);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /unknown op/);
  assert.deepEqual(readState(dir), before);
  assert.equal(fs.existsSync(path.join(dir, 'journal.json')), false);
  assert.deepEqual(tempFiles(dir), []);
});

test('dangerous op without inverse is rejected with exit 1 and nothing is persisted', () => {
  const dir = makeDir();
  runCli(['init', dir]);
  const setup = writePatch(dir, {
    ops: [
      {
        type: 'put-file',
        expectVersion: 0,
        path: 'secret.bin',
        content: 'x',
        inverse: { type: 'delete-file', path: 'secret.bin' },
      },
    ],
  });
  assert.equal(runCli(['apply', dir, setup]).status, 0);
  const before = readState(dir);

  const bad = writePatch(dir, {
    ops: [{ type: 'delete-file', expectVersion: 1, path: 'secret.bin' }],
  });
  const result = runCli(['apply', dir, bad]);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /requires an inverse/);
  assert.deepEqual(readState(dir), before);
  assert.equal(readJournal(dir).status, 'committed'); // only the setup journal
  assert.deepEqual(tempFiles(dir), []);
});

test('conditional version mismatch is rejected with exit 1 and nothing is persisted', () => {
  const dir = makeDir();
  runCli(['init', dir]);
  const before = readState(dir);
  const patchFile = writePatch(dir, {
    ops: [
      {
        type: 'set-attr',
        expectVersion: 7,
        key: 'a',
        value: 1,
        inverse: { type: 'delete-attr', key: 'a' },
      },
    ],
  });

  const result = runCli(['apply', dir, patchFile]);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /conditional version mismatch/);
  assert.deepEqual(readState(dir), before);
  assert.equal(fs.existsSync(path.join(dir, 'journal.json')), false);
  assert.deepEqual(tempFiles(dir), []);
});
