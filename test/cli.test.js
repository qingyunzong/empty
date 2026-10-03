'use strict';

// Acceptance 2 & 4 via the real CLI: tampering exits 4 with an offset;
// proof output is re-verifiable by the independent verify-proof subcommand.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync, spawnSync } = require('node:child_process');
const { tmpdir } = require('./util');

const CLI = path.join(__dirname, '..', 'cli.js');

// NOTE: this sandbox drops grandchild stdout when it is a pipe, so capture
// child output via temp files instead of { encoding: 'utf8' } pipes.
let captureCounter = 0;
function run(args, opts = {}) {
  const dir = tmpdir('ledger-cli-cap-');
  const outPath = path.join(dir, `out-${captureCounter++}.txt`);
  const errPath = path.join(dir, `err-${captureCounter}.txt`);
  const outFd = fs.openSync(outPath, 'w');
  const errFd = fs.openSync(errPath, 'w');
  const r = spawnSync(process.execPath, [CLI, ...args], { stdio: ['ignore', outFd, errFd], ...opts });
  fs.closeSync(outFd);
  fs.closeSync(errFd);
  return { status: r.status, stdout: fs.readFileSync(outPath, 'utf8'), stderr: fs.readFileSync(errPath, 'utf8'), error: r.error };
}

function lineOffsets(file) {
  const buf = fs.readFileSync(file);
  const offsets = [];
  let cur = 0;
  for (let i = 0; i < buf.length; i++) {
    if (buf[i] === 0x0a) { offsets.push(cur); cur = i + 1; }
  }
  return offsets;
}

test('CLI end-to-end: log/verify/view/proof/verify-proof, tamper -> exit 4 + offset', () => {
  const dir = tmpdir('ledger-cli-');
  const log = path.join(dir, 'ledger.log');
  const proofFile = path.join(dir, 'proof.json');

  // log: 3 posts + 1 correction + 1 tombstone
  const p1 = JSON.parse(run(['log', '--file', log, '--account', 'alice', '--amount', '1000', '--biz-key', 'inv-1', '--ts', '1700000000000', '--biz-time', '1700000000000']).stdout);
  run(['log', '--file', log, '--account', 'alice', '--amount', '500', '--biz-key', 'inv-2', '--ts', '1700000001000', '--biz-time', '1700000000900']);
  const p3 = JSON.parse(run(['log', '--file', log, '--account', 'bob', '--amount', '250', '--biz-key', 'inv-3', '--ts', '1700000002000', '--biz-time', '1700000002000']).stdout);
  run(['log', '--file', log, '--type', 'correct', '--account', 'alice', '--amount', '1200', '--supersedes', p1.hash, '--ts', '1700000003000', '--biz-time', '1700000000050']);
  run(['log', '--file', log, '--type', 'tombstone', '--account', 'bob', '--supersedes', p3.hash, '--ts', '1700000004000', '--biz-time', '1700000002100']);

  // verify: clean log exits 0
  let r = run(['verify', '--file', log]);
  assert.equal(r.status, 0, r.stdout + r.stderr);
  const okRes = JSON.parse(r.stdout);
  assert.equal(okRes.ok, true);
  assert.equal(okRes.entries, 5);

  // view: alice = 1200 (corrected) + 500, bob = 0 (tombstoned)
  r = run(['view', '--file', log]);
  assert.equal(r.status, 0);
  const view = JSON.parse(r.stdout);
  assert.equal(view.accounts.alice.balance, 1700);
  assert.equal(view.accounts.bob.balance, 0);
  assert.equal(view.accounts.bob.tombstoned.length, 1);

  // proof + independent verify-proof
  r = run(['proof', '--file', log, '--account', 'alice', '--out', proofFile]);
  assert.equal(r.status, 0, r.stderr);
  r = run(['verify-proof', '--proof', proofFile, '--file', log]);
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.equal(JSON.parse(r.stdout).ok, true);

  // corrupted proof must fail with exit 4
  const badProof = JSON.parse(fs.readFileSync(proofFile, 'utf8'));
  badProof.entries[0].op.amount = 1;
  const badProofFile = path.join(dir, 'bad-proof.json');
  fs.writeFileSync(badProofFile, JSON.stringify(badProof));
  r = run(['verify-proof', '--proof', badProofFile, '--file', log]);
  assert.equal(r.status, 4);
  assert.equal(JSON.parse(r.stdout).ok, false);

  // tamper: flip one byte in the middle of the log -> exit 4 with offset
  const size = fs.statSync(log).size;
  const mid = Math.floor(size / 2);
  const buf = fs.readFileSync(log);
  buf[mid] = buf[mid] === 0x30 ? 0x31 : 0x30;
  fs.writeFileSync(log, buf);

  r = run(['verify', '--file', log]);
  assert.equal(r.status, 4, `expected exit 4, got ${r.status}: ${r.stdout}`);
  const failRes = JSON.parse(r.stdout);
  assert.equal(failRes.ok, false);
  assert.equal(typeof failRes.offset, 'number');
  const offsets = lineOffsets(log);
  assert.ok(offsets.includes(failRes.offset), `offset ${failRes.offset} must be a line start`);
  const badLineEnd = fs.readFileSync(log).indexOf(0x0a, failRes.offset);
  assert.ok(failRes.offset <= mid && mid < badLineEnd, 'reported entry must contain the tampered byte');
  assert.equal(fs.statSync(log).size, size); // log not truncated on failure
});
