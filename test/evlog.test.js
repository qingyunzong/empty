'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { run: cliRun } = require('../cli');

const {
  GENESIS_HASH,
  open,
  recover,
  verify,
  tail,
  encodeBlock,
  checkpointPath,
} = require('../lib/evlog');

const CLI = path.join(__dirname, '..', 'cli.js');

function tmpLog(name) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'evlog-test-'));
  return path.join(dir, name || 'log');
}

function payloads(log, n) {
  return tail(log, n).map((e) => e.payload);
}

function runCli(args) {
  const { code, stdout, stderr } = cliRun(args);
  return { status: code, stdout, stderr };
}

// Rebuilds the line for `blockObj` with a valid CRC but tampered fields.
function tamperedLine(obj, patch) {
  return encodeBlock({
    seq: patch.seq !== undefined ? patch.seq : obj.seq,
    prevHash: patch.prevHash !== undefined ? patch.prevHash : obj.prevHash,
    payload: patch.payload !== undefined ? patch.payload : obj.payload,
    committed: patch.committed !== undefined ? patch.committed : obj.committed,
  });
}

function rewriteLine(log, index, newLine) {
  const lines = fs.readFileSync(log, 'utf8').split('\n');
  lines[index] = newLine;
  fs.writeFileSync(log, lines.join('\n'));
}

test('1a. crash during append (torn block) recovers to last commit, deterministically', () => {
  const log = tmpLog();
  const h = open(log);
  h.append('e1');
  const c1 = h.commit();
  h.append('e2'); // complete but uncommitted
  // Torn write: half of the next block hits disk, no newline.
  const partial = encodeBlock({ seq: 3, prevHash: '0'.repeat(64), payload: 'e3', committed: false }).slice(0, 19);
  fs.appendFileSync(log, partial);

  const r1 = recover(log);
  assert.equal(r1.root, c1.root);
  assert.equal(r1.lastSeq, c1.lastSeq);
  assert.ok(r1.truncatedBytes > 0);
  assert.deepEqual(payloads(log), ['e1']);

  const r2 = recover(log);
  assert.equal(r2.root, r1.root);
  assert.equal(r2.lastSeq, r1.lastSeq);
  assert.equal(r2.truncatedBytes, 0); // idempotent
  assert.equal(verify(log).ok, true);
  const ckp = JSON.parse(fs.readFileSync(checkpointPath(log), 'utf8'));
  assert.equal(ckp.root, c1.root);
});

test('1b. crash during commit block write recovers to last complete commit', () => {
  const log = tmpLog();
  const h = open(log);
  h.append('e1');
  const c1 = h.commit();
  h.append('e2'); // uncommitted
  // Torn commit block: only a fragment of the commit marker is written.
  const partialCommit = encodeBlock({ seq: 4, prevHash: '0'.repeat(64), payload: null, committed: true }).slice(0, 23);
  fs.appendFileSync(log, partialCommit);

  const r = recover(log);
  assert.equal(r.root, c1.root);
  assert.deepEqual(payloads(log), ['e1']);
  assert.equal(verify(log).ok, true);
});

test('1c. stale checkpoint is rebuilt from the log to the last complete commit', () => {
  const log = tmpLog();
  const h = open(log);
  h.append('e1');
  h.commit();
  const staleCkp = fs.readFileSync(checkpointPath(log)); // checkpoint after commit 1
  h.append('e2');
  const c2 = h.commit();
  // Simulate crash after log fsync but before checkpoint update.
  fs.writeFileSync(checkpointPath(log), staleCkp);

  const r = recover(log);
  assert.equal(r.root, c2.root);
  assert.equal(r.lastSeq, c2.lastSeq);
  const ckp = JSON.parse(fs.readFileSync(checkpointPath(log), 'utf8'));
  assert.equal(ckp.root, c2.root);
  assert.deepEqual(payloads(log), ['e1', 'e2']);
  assert.equal(verify(log).ok, true);
});

test('2. all prefixes of a small log: tail returns exactly the committed prefix', () => {
  const entries = ['alpha', 'beta', 'gamma', 'delta'];
  for (let k = 0; k <= entries.length; k++) {
    const log = tmpLog();
    const h = open(log);
    for (let i = 0; i < k; i++) {
      h.append(entries[i]);
      h.commit(); // commit after every entry: multi-commit chain
    }
    assert.deepEqual(payloads(log), entries.slice(0, k));
    assert.equal(verify(log).ok, true);
  }
  // Slicing variants on a full log.
  const log = tmpLog();
  const h = open(log);
  for (const e of entries) h.append(e);
  h.commit();
  for (let n = 0; n <= entries.length + 2; n++) {
    assert.deepEqual(payloads(log, n), entries.slice(Math.max(0, entries.length - n)));
  }
  // Uncommitted appends are invisible to tail.
  h.append('draft');
  assert.deepEqual(payloads(log), entries);
  assert.equal(verify(log).pending, 1);
});

test('3. second committer based on a stale root is rejected with ERR_STALE_ROOT', () => {
  const log = tmpLog();
  const h1 = open(log);
  const h2 = open(log); // both handles base on the same (genesis) root
  h1.append('from-h1');
  h1.commit(); // moves the committed root
  h2.append('from-h2'); // h2 still based on the old root
  assert.throws(() => h2.commit(), (err) => err.code === 'ERR_STALE_ROOT');

  const r = recover(log);
  assert.deepEqual(payloads(log), ['from-h1']); // h2's block discarded
  assert.equal(verify(log).ok, true);
  assert.equal(r.root, h1.baseRoot);
});

test('4. corrupt or missing checkpoint is rebuilt from the log', () => {
  const log = tmpLog();
  const h = open(log);
  h.append('a');
  h.commit();
  h.append('b');
  const c2 = h.commit();

  fs.writeFileSync(checkpointPath(log), 'not json {{{');
  const r = recover(log);
  assert.equal(r.root, c2.root);
  const ckp = JSON.parse(fs.readFileSync(checkpointPath(log), 'utf8'));
  assert.deepEqual(ckp, { lastSeq: c2.lastSeq, root: c2.root });
  assert.equal(verify(log).ok, true);

  fs.unlinkSync(checkpointPath(log));
  const r2 = recover(log);
  assert.equal(r2.root, c2.root);
  assert.equal(verify(log).ok, true);
});

test('5. empty log: recover is idempotent', () => {
  const log = tmpLog();
  const r1 = recover(log); // log does not even exist yet
  assert.equal(r1.lastSeq, 0);
  assert.equal(r1.root, GENESIS_HASH);
  const c1 = fs.readFileSync(checkpointPath(log), 'utf8');
  const r2 = recover(log);
  assert.deepEqual(r2, r1);
  assert.equal(fs.readFileSync(checkpointPath(log), 'utf8'), c1);
  assert.deepEqual(tail(log), []);
  const v = verify(log);
  assert.equal(v.ok, true);
  assert.equal(v.entries, 0);
});

test('ERR_FORK: tampered prevHash in committed region is rejected', () => {
  const log = tmpLog();
  const h = open(log);
  h.append('x');
  h.commit();
  const first = JSON.parse(fs.readFileSync(log, 'utf8').split('\n')[0]);
  rewriteLine(log, 0, tamperedLine(first, { prevHash: 'f'.repeat(64) }));
  assert.throws(() => verify(log), (err) => err.code === 'ERR_FORK');
  assert.throws(() => tail(log), (err) => err.code === 'ERR_FORK');
});

test('ERR_CRC: corrupted committed block is rejected', () => {
  const log = tmpLog();
  const h = open(log);
  h.append('x');
  h.commit();
  const lines = fs.readFileSync(log, 'utf8').split('\n');
  lines[0] = lines[0].replace('"x"', '"y"'); // payload changed, crc stale
  fs.writeFileSync(log, lines.join('\n'));
  assert.throws(() => verify(log), (err) => err.code === 'ERR_CRC');
});

test('ERR_SEQ: sequence regression in committed region is rejected', () => {
  const log = tmpLog();
  const h = open(log);
  h.append('a');
  h.commit();
  h.append('b');
  h.commit();
  const lines = fs.readFileSync(log, 'utf8').split('\n');
  const third = JSON.parse(lines[2]);
  rewriteLine(log, 2, tamperedLine(third, { seq: 1 })); // seq goes backwards
  assert.throws(() => verify(log), (err) => err.code === 'ERR_SEQ');
});

test('CLI: append/commit/tail/verify/recover roundtrip', () => {
  const log = tmpLog();
  let r = runCli(['append', log, 'hello world']);
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(JSON.parse(r.stdout), { ok: true, seq: 1 });

  r = runCli(['commit', log]);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(JSON.parse(r.stdout).ok, true);

  r = runCli(['append', log, 'second']);
  assert.equal(r.status, 0, r.stderr);

  r = runCli(['tail', log]); // uncommitted entry must not show
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(JSON.parse(r.stdout).entries, [{ seq: 1, payload: 'hello world' }]);

  r = runCli(['recover', log]); // discards the uncommitted entry
  assert.equal(r.status, 0, r.stderr);
  assert.equal(JSON.parse(r.stdout).ok, true);

  r = runCli(['verify', log]);
  assert.equal(r.status, 0, r.stderr);
  const v = JSON.parse(r.stdout);
  assert.equal(v.ok, true);
  assert.equal(v.entries, 1);

  r = runCli(['tail', log, '1']);
  assert.deepEqual(JSON.parse(r.stdout).entries, [{ seq: 1, payload: 'hello world' }]);
});

test('CLI: errors are JSON on stderr with non-zero exit', () => {
  const log = tmpLog();
  assert.equal(runCli(['append', log, 'x']).status, 0);
  assert.equal(runCli(['commit', log]).status, 0);
  const first = JSON.parse(fs.readFileSync(log, 'utf8').split('\n')[0]);
  rewriteLine(log, 0, tamperedLine(first, { prevHash: 'f'.repeat(64) }));

  const r = runCli(['verify', log]);
  assert.notEqual(r.status, 0);
  assert.equal(r.stdout, '');
  const err = JSON.parse(r.stderr);
  assert.equal(err.error, 'ERR_FORK');
  assert.equal(typeof err.message, 'string');
});
