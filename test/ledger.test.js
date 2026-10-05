'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const {
  Ledger,
  ConflictError,
  SealedError,
  GENESIS_HASH,
} = require('../ledger');

const CLI = path.join(__dirname, '..', 'index.js');

function makeLedger(...commitPatches) {
  const ledger = new Ledger();
  for (const patches of commitPatches) ledger.apply(patches);
  return ledger;
}

test('apply/undo/redo: state and cursor stay correct', () => {
  const ledger = new Ledger();
  ledger.apply([{ key: 'a', old: null, new: 1 }]);
  ledger.apply([
    { key: 'a', old: 1, new: 2 },
    { key: 'b', old: null, new: 10 },
  ]);
  assert.equal(ledger.cursor, 2);
  assert.deepEqual(ledger.state, { a: 2, b: 10 });

  // inverse patch generated per patch
  assert.deepEqual(ledger.commits[1].inverse, [
    { key: 'a', old: 2, new: 1 },
    { key: 'b', old: 10, new: null },
  ]);

  assert.equal(ledger.undo(), true);
  assert.equal(ledger.cursor, 1);
  assert.deepEqual(ledger.state, { a: 1 });
  assert.equal(ledger.length, 2, 'undo must not delete history');

  assert.equal(ledger.undo(), true);
  assert.deepEqual(ledger.state, {});
  assert.equal(ledger.undo(), false, 'undo at genesis is a no-op');

  assert.equal(ledger.redo(), true);
  assert.equal(ledger.redo(), true);
  assert.equal(ledger.cursor, 2);
  assert.deepEqual(ledger.state, { a: 2, b: 10 });
  assert.equal(ledger.redo(), false, 'redo at tip is a no-op');
});

test('apply after undo truncates the old branch; it is unrecoverable', () => {
  const ledger = makeLedger(
    [{ key: 'a', old: null, new: 1 }],
    [{ key: 'b', old: null, new: 2 }]
  );
  ledger.undo();
  ledger.apply([{ key: 'c', old: null, new: 3 }]);

  assert.equal(ledger.length, 2);
  assert.equal(ledger.cursor, 2);
  assert.deepEqual(ledger.state, { a: 1, c: 3 });
  assert.equal(ledger.commits[1].patches[0].key, 'c');
  assert.equal(ledger.redo(), false, 'old branch (b) is gone forever');
});

test('apply enforces the old-value guard', () => {
  const ledger = makeLedger([{ key: 'a', old: null, new: 1 }]);
  assert.throws(
    () => ledger.apply([{ key: 'a', old: 9, new: 2 }]),
    (err) => err instanceof ConflictError && err.details.seq === 2
  );
  assert.equal(ledger.length, 1, 'failed apply must not append');
});

test('rewrite without guard conflicts replays successors and updates hashes', () => {
  const ledger = makeLedger(
    [{ key: 'a', old: null, new: 1 }],
    [{ key: 'b', old: null, new: 10 }],
    [{ key: 'c', old: null, new: 100 }],
    [{ key: 'c', old: 100, new: 101 }]
  );
  const before = ledger.commits.map((c) => c.hash);

  const { hashMap } = ledger.rewrite(2, [{ key: 'b', old: null, new: 20 }]);

  assert.deepEqual(ledger.state, { a: 1, b: 20, c: 101 });
  assert.equal(ledger.cursor, 4);
  assert.equal(ledger.commits[0].hash, before[0], 'prefix before rewrite keeps its hash');
  for (let i = 1; i < 4; i++) {
    assert.notEqual(ledger.commits[i].hash, before[i], `commit ${i + 1} hash must change`);
    assert.equal(hashMap[before[i]], ledger.commits[i].hash, 'old->new hash mapping');
  }
  assert.deepEqual(Object.keys(hashMap).sort(), [before[1], before[2], before[3]].sort());
  // hash chain is consistent after rewrite
  assert.equal(ledger.commits[0].prevHash, GENESIS_HASH);
  for (let i = 1; i < 4; i++) {
    assert.equal(ledger.commits[i].prevHash, ledger.commits[i - 1].hash);
  }
  // successors were genuinely replayed against the new value
  assert.equal(ledger.commits[2].patches[0].new, 100);
  assert.equal(ledger.commits[3].patches[0].old, 100);
});

test('rewrite conflict reports the first failing point and leaves the ledger untouched', () => {
  const ledger = makeLedger(
    [{ key: 'a', old: null, new: 1 }],
    [{ key: 'b', old: null, new: 10 }],
    [{ key: 'c', old: null, new: 100 }],
    [{ key: 'b', old: 10, new: 99 }]
  );
  const beforeJson = JSON.stringify(ledger.toJSON());
  const beforeCommits = ledger.commits;

  let caught;
  try {
    ledger.rewrite(2, [{ key: 'b', old: null, new: 20 }]);
  } catch (err) {
    caught = err;
  }
  assert.ok(caught instanceof ConflictError);
  assert.deepEqual(caught.details, {
    seq: 4,
    patchIndex: 0,
    key: 'b',
    expected: 10,
    actual: 20,
  });
  assert.equal(ledger.commits, beforeCommits, 'commit array must not be swapped on failure');
  assert.equal(JSON.stringify(ledger.toJSON()), beforeJson, 'ledger content unchanged');
  assert.equal(ledger.cursor, 4);
});

test('rewrite of a sealed commit is rejected', () => {
  const ledger = makeLedger(
    [{ key: 'a', old: null, new: 1 }],
    [{ key: 'b', old: null, new: 2 }]
  );
  ledger.seal(1);
  assert.throws(() => ledger.rewrite(1, [{ key: 'a', old: null, new: 9 }]), SealedError);
  assert.equal(ledger.commits[0].patches[0].new, 1, 'sealed commit untouched');
});

test('exhaustive <=5-key patch sequences cross-checked against inverse replay', () => {
  const keys = ['k1', 'k2', 'k3', 'k4', 'k5'];
  const MAX_DEPTH = 4;

  // Enumerate every guard-valid sequence: each step picks one of the 5 keys
  // and cycles its value null -> 0 -> 1 -> 2 -> 0 ...
  function* sequences(state, depth) {
    yield [];
    if (depth === 0) return;
    for (const key of keys) {
      const current = Object.prototype.hasOwnProperty.call(state, key) ? state[key] : null;
      const next = current === null ? 0 : (current + 1) % 3;
      const patch = { key, old: current, new: next };
      state[key] = next;
      for (const rest of sequences(state, depth - 1)) yield [patch, ...rest];
      state[key] = current;
      if (current === null) delete state[key];
    }
  }

  let checked = 0;
  for (const seq of sequences({}, MAX_DEPTH)) {
    const initial = {};
    const ledger = new Ledger();
    for (const patch of seq) ledger.apply([patch]);
    const finalState = ledger.state;
    const finalCursor = ledger.cursor;

    // undo all the way: cursor-only movement back to the initial state
    while (ledger.undo()) {}
    assert.equal(ledger.cursor, 0);
    assert.deepEqual(ledger.state, initial);
    // redo all the way back
    while (ledger.redo()) {}
    assert.equal(ledger.cursor, finalCursor);
    assert.deepEqual(ledger.state, finalState);

    // inverse replay: apply inverse patches in reverse order on a fresh ledger
    const mirror = new Ledger();
    for (const patch of seq) mirror.apply([patch]);
    for (let i = seq.length - 1; i >= 0; i--) {
      const inv = mirror.commits[i].inverse[0];
      mirror.apply([inv]);
    }
    assert.deepEqual(mirror.state, initial, `inverse replay of ${JSON.stringify(seq)}`);
    checked += 1;
  }
  assert.equal(checked, 1 + 5 + 25 + 125 + 625);
});

// ---------- CLI ----------

function tmpdir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'ledger-'));
}

function writeBook(file, commitPatches, opts = {}) {
  const ledger = makeLedger(...commitPatches);
  if (opts.seal) for (const seq of opts.seal) ledger.seal(seq);
  fs.writeFileSync(file, JSON.stringify(ledger.toJSON(), null, 2));
  return ledger;
}

// This sandbox swallows child-process pipes, so capture stdio via temp files.
function runCli(args) {
  const dir = tmpdir();
  const stdoutFile = path.join(dir, 'stdout.txt');
  const stderrFile = path.join(dir, 'stderr.txt');
  const outFd = fs.openSync(stdoutFile, 'w');
  const errFd = fs.openSync(stderrFile, 'w');
  const res = spawnSync(process.execPath, [CLI, ...args], { stdio: ['ignore', outFd, errFd] });
  fs.closeSync(outFd);
  fs.closeSync(errFd);
  return {
    status: res.status,
    stdout: fs.readFileSync(stdoutFile, 'utf8'),
    stderr: fs.readFileSync(stderrFile, 'utf8'),
  };
}

test('CLI rewrite: success exits 0, writes new book and hash mapping', () => {
  const dir = tmpdir();
  const book = path.join(dir, 'b.json');
  const patch = path.join(dir, 'p.json');
  const out = path.join(dir, 'n.json');
  const original = writeBook(book, [
    [{ key: 'a', old: null, new: 1 }],
    [{ key: 'b', old: null, new: 10 }],
    [{ key: 'c', old: null, new: 100 }],
  ]);
  fs.writeFileSync(patch, JSON.stringify([{ key: 'b', old: null, new: 20 }]));

  const res = runCli(['rewrite', '--book', book, '--seq', '2', '--patch', patch, '--out', out]);
  assert.equal(res.status, 0, res.stderr);

  const mapping = JSON.parse(res.stdout).hashMap;
  const rewritten = Ledger.fromJSON(JSON.parse(fs.readFileSync(out, 'utf8')));
  assert.deepEqual(rewritten.state, { a: 1, b: 20, c: 100 });
  assert.equal(mapping[original.commits[1].hash], rewritten.commits[1].hash);
  assert.equal(mapping[original.commits[2].hash], rewritten.commits[2].hash);
  assert.equal(rewritten.commits[0].hash, original.commits[0].hash);
});

test('CLI rewrite: conflict exits 1, reports first failure, book and out untouched', () => {
  const dir = tmpdir();
  const book = path.join(dir, 'b.json');
  const patch = path.join(dir, 'p.json');
  const out = path.join(dir, 'n.json');
  writeBook(book, [
    [{ key: 'a', old: null, new: 1 }],
    [{ key: 'b', old: null, new: 10 }],
    [{ key: 'b', old: 10, new: 99 }],
  ]);
  const before = fs.readFileSync(book, 'utf8');
  fs.writeFileSync(patch, JSON.stringify({ patches: [{ key: 'b', old: null, new: 20 }] }));

  const res = runCli(['rewrite', '--book', book, '--seq', '2', '--patch', patch, '--out', out]);
  assert.equal(res.status, 1, res.stderr);
  const details = JSON.parse(res.stderr.trim().split('\n').pop());
  assert.deepEqual(details, { seq: 3, patchIndex: 0, key: 'b', expected: 10, actual: 20 });
  assert.equal(fs.readFileSync(book, 'utf8'), before, 'original book file unchanged');
  assert.equal(fs.existsSync(out), false, 'no output book on conflict');
});

test('CLI rewrite: sealed commit exits 2', () => {
  const dir = tmpdir();
  const book = path.join(dir, 'b.json');
  const patch = path.join(dir, 'p.json');
  const out = path.join(dir, 'n.json');
  writeBook(book, [[{ key: 'a', old: null, new: 1 }]], { seal: [1] });
  fs.writeFileSync(patch, JSON.stringify([{ key: 'a', old: null, new: 9 }]));

  const res = runCli(['rewrite', '--book', book, '--seq', '1', '--patch', patch, '--out', out]);
  assert.equal(res.status, 2);
  assert.match(res.stderr, /sealed/);
  assert.equal(fs.existsSync(out), false);
});

test('CLI: argument errors exit 2', () => {
  const dir = tmpdir();
  const book = path.join(dir, 'b.json');
  writeBook(book, [[{ key: 'a', old: null, new: 1 }]]);

  assert.equal(runCli(['rewrite', '--book', book, '--seq', '1']).status, 2, 'missing flags');
  assert.equal(
    runCli(['rewrite', '--book', book, '--seq', 'x', '--patch', 'p.json', '--out', 'n.json']).status,
    2,
    'non-integer seq'
  );
  assert.equal(
    runCli(['rewrite', '--book', book, '--seq', '9', '--patch', book, '--out', 'n.json']).status,
    2,
    'seq out of range'
  );
  assert.equal(runCli(['bogus']).status, 2, 'unknown command');
  assert.equal(runCli([]).status, 2, 'no command');
});
