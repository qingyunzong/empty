'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { tmpDir, cleanup } = require('./helpers.js');

const BIN = path.join(__dirname, '..', 'bin', 'wip-count.js');

// The sandboxed environment does not reliably propagate grandchild stdout
// through pipes, so capture via temp files instead.
let captureCounter = 0;
function run(args) {
  const base = path.join(os.tmpdir(), `wip-cli-${process.pid}-${captureCounter++}`);
  const outFile = base + '.out';
  const errFile = base + '.err';
  const outFd = fs.openSync(outFile, 'w');
  const errFd = fs.openSync(errFile, 'w');
  let res;
  try {
    res = spawnSync(process.execPath, [BIN, ...args], { stdio: ['ignore', outFd, errFd] });
  } finally {
    fs.closeSync(outFd);
    fs.closeSync(errFd);
  }
  const stdout = fs.readFileSync(outFile, 'utf8');
  const stderr = fs.readFileSync(errFile, 'utf8');
  fs.unlinkSync(outFile);
  fs.unlinkSync(errFile);
  assert.equal(res.error, undefined);
  return { status: res.status, stdout, stderr };
}

function stderrJson(res) {
  assert.ok(res.stderr.trim().length > 0, 'expected JSON on stderr');
  const parsed = JSON.parse(res.stderr);
  assert.ok(parsed.error && typeof parsed.error.code === 'string' && typeof parsed.error.message === 'string');
  return parsed;
}

test('CLI happy path: init/begin/scan/adjust/close/verify', () => {
  const dir = tmpDir();
  try {
    assert.equal(run(['init', '--dir', dir, '--node', 'A']).status, 0);
    assert.equal(run(['begin', '--dir', dir, '--session', 'S1']).status, 0);
    assert.equal(run(['scan', '--dir', dir, '--session', 'S1', '--bin', 'A-01', '--item', 'ITM-0001', '--qty', '4']).status, 0);
    assert.equal(run(['adjust', '--dir', dir, '--session', 'S1', '--bin', 'A-01', '--item', 'ITM-0001', '--delta', '-1']).status, 0);
    assert.equal(run(['close', '--dir', dir, '--session', 'S1']).status, 0);
    const v = run(['verify', '--dir', dir]);
    assert.equal(v.status, 0);
    assert.equal(JSON.parse(v.stdout).ok, true);
  } finally { cleanup(dir); }
});

test('CLI exit 2 with stderr JSON on validation errors', () => {
  const dir = tmpDir();
  try {
    run(['begin', '--dir', dir, '--session', 'S1', '--node', 'A']);
    const bad = run(['scan', '--dir', dir, '--session', 'S1', '--bin', 'nope', '--item', 'ITM-0001']);
    assert.equal(bad.status, 2);
    assert.equal(stderrJson(bad).error.code, 'INVALID_BARCODE');
    const badQty = run(['scan', '--dir', dir, '--session', 'S1', '--bin', 'A-01', '--item', 'ITM-0001', '--qty', '1.5']);
    assert.equal(badQty.status, 2);
    assert.equal(stderrJson(badQty).error.code, 'INVALID_QTY');
    const neg = run(['adjust', '--dir', dir, '--session', 'S1', '--bin', 'A-01', '--item', 'ITM-0001', '--delta', '-5']);
    assert.equal(neg.status, 2);
    assert.equal(stderrJson(neg).error.code, 'NEGATIVE_INVENTORY');
    const usage = run(['scan', '--dir', dir, '--session', 'S1']);
    assert.equal(usage.status, 2);
    assert.equal(stderrJson(usage).error.code, 'USAGE');
  } finally { cleanup(dir); }
});

test('CLI exit 3 with stderr JSON on state conflicts (CLOSED etc.)', () => {
  const dir = tmpDir();
  try {
    run(['begin', '--dir', dir, '--session', 'S1', '--node', 'A']);
    run(['scan', '--dir', dir, '--session', 'S1', '--bin', 'A-01', '--item', 'ITM-0001']);
    run(['close', '--dir', dir, '--session', 'S1']);
    const closed = run(['scan', '--dir', dir, '--session', 'S1', '--bin', 'A-01', '--item', 'ITM-0001']);
    assert.equal(closed.status, 3);
    assert.equal(stderrJson(closed).error.code, 'CLOSED');
    const undoClosed = run(['undo', '--dir', dir, '--session', 'S1']);
    assert.equal(undoClosed.status, 3);
    assert.equal(stderrJson(undoClosed).error.code, 'CLOSED');
    const missing = run(['close', '--dir', dir, '--session', 'GHOST']);
    assert.equal(missing.status, 3);
    assert.equal(stderrJson(missing).error.code, 'SESSION_NOT_FOUND');
  } finally { cleanup(dir); }
});

test('CLI exit 10 with stderr JSON when verify detects divergence', () => {
  const dir = tmpDir();
  try {
    run(['begin', '--dir', dir, '--session', 'S1', '--node', 'A']);
    run(['scan', '--dir', dir, '--session', 'S1', '--bin', 'A-01', '--item', 'ITM-0001', '--qty', '2']);
    run(['close', '--dir', dir, '--session', 'S1']);
    // corrupt the ledger out-of-band
    const fs = require('node:fs');
    const statePath = path.join(dir, 'state.json');
    const state = JSON.parse(fs.readFileSync(statePath, 'utf8'));
    state.inventory['A-01|ITM-0001'] = 99;
    fs.writeFileSync(statePath, JSON.stringify(state));
    const v = run(['verify', '--dir', dir]);
    assert.equal(v.status, 10);
    assert.equal(stderrJson(v).error.code, 'VERIFY_MISMATCH');
  } finally { cleanup(dir); }
});

test('CLI sync + resume commands work across two data dirs', () => {
  const dirA = tmpDir();
  const dirB = tmpDir();
  try {
    run(['begin', '--dir', dirA, '--session', 'S1', '--node', 'A']);
    run(['scan', '--dir', dirA, '--session', 'S1', '--bin', 'A-01', '--item', 'ITM-0001', '--qty', '5']);
    run(['close', '--dir', dirA, '--session', 'S1']);
    run(['init', '--dir', dirB, '--node', 'B']);
    const s = run(['sync', '--dir', dirA, '--peer', dirB]);
    assert.equal(s.status, 0);
    const vb = run(['verify', '--dir', dirB]);
    assert.equal(vb.status, 0);
    const r = run(['resume', '--dir', dirA]);
    assert.equal(r.status, 0);
    assert.deepEqual(JSON.parse(r.stdout), { replayed: 0, finalized: 0, drained: 0, pending: 0 });
  } finally { cleanup(dirA); cleanup(dirB); }
});
