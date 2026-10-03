'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const CLI = path.join(__dirname, '..', 'src', 'cli.js');

// ---- Independent enumerators ------------------------------------------------
const STAGES = ['VALIDATED', 'FROZEN', 'POSTED', 'NOTIFIED'];
const CRASH_POINTS = STAGES.slice(); // one fault point per stage
const CANCEL_POINTS = ['BEFORE_POSTED', 'AFTER_POSTED', 'AFTER_COMPLETE'];

const AMOUNT = 100;
const OPENING = { payer: { available: 1000, frozen: 0 }, payee: { available: 0, frozen: 0 } };

// ---- Expected terminal states, derived directly from the enumerators --------
function expectedCleanRun() {
  return {
    status: 'NOTIFIED',
    stages: STAGES.slice(),
    balances: { payer: { available: 900, frozen: 0 }, payee: { available: 100, frozen: 0 } },
  };
}

// A crash at any fault point must converge to the clean run after recovery.
function expectedAfterCrash(crashPoint) {
  assert.ok(CRASH_POINTS.includes(crashPoint));
  return expectedCleanRun();
}

function expectedAfterCancel(point) {
  assert.ok(CANCEL_POINTS.includes(point));
  const idx = CANCEL_POINTS.indexOf(point);
  const posted = idx >= CANCEL_POINTS.indexOf('AFTER_POSTED');
  return {
    status: posted ? 'REFUNDED' : 'CANCELLED',
    stages: posted ? STAGES.slice(0, point === 'AFTER_COMPLETE' ? 4 : 3) : STAGES.slice(0, 2),
    // cancel before POST releases the freeze; after POST a reversal restores
    // both accounts, so every cancel point ends with the opening balances
    balances: OPENING,
  };
}

// ---- Helpers ----------------------------------------------------------------
function mktmp() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'pay-test-'));
}

let outCounter = 0;

// NOTE: this sandboxed environment drops piped stdout of nested node
// processes, so the child's stdout is redirected to a file and read back.
function run(stateDir, cmd, crashPoint) {
  const args = [CLI, '--state', stateDir, '--cmd', JSON.stringify(cmd)];
  if (crashPoint) args.push('--crash-point', crashPoint);
  const outPath = path.join(stateDir, `stdout-${outCounter++}.txt`);
  const fd = fs.openSync(outPath, 'w');
  const res = spawnSync(process.execPath, args, { stdio: ['ignore', fd, 'pipe'], encoding: 'utf8' });
  fs.closeSync(fd);
  res.stdout = fs.readFileSync(outPath, 'utf8');
  return res;
}

function runOk(stateDir, cmd, crashPoint) {
  const res = run(stateDir, cmd, crashPoint);
  assert.equal(res.signal, null, `unexpected signal: ${res.signal}`);
  assert.equal(res.status, 0, `exit ${res.status}: ${res.stdout} ${res.stderr}`);
  return JSON.parse(res.stdout);
}

function runCrash(stateDir, cmd, crashPoint) {
  const res = run(stateDir, cmd, crashPoint);
  assert.equal(res.signal, 'SIGKILL', `expected crash at ${crashPoint}, got ${res.status}/${res.signal}`);
  return res;
}

function runErr(stateDir, cmd) {
  const res = run(stateDir, cmd);
  assert.equal(res.status, 1, `expected exit 1: ${res.stdout}`);
  const body = JSON.parse(res.stdout);
  assert.equal(body.ok, false);
  return body.error;
}

function readEvents(stateDir) {
  return fs
    .readFileSync(path.join(stateDir, 'events.jsonl'), 'utf8')
    .split('\n')
    .filter(Boolean)
    .map(JSON.parse);
}

function stageEvents(stateDir, paymentId) {
  return readEvents(stateDir).filter((e) => e.type === 'STAGE' && e.paymentId === paymentId);
}

function payCmd(id, amount = AMOUNT) {
  return { type: 'PAY', commandId: `cmd-pay-${id}`, paymentId: `pay-${id}`, amount };
}

function cancelCmd(id, paymentId) {
  return { type: 'CANCEL', commandId: `cmd-cancel-${id}`, paymentId };
}

// Drives a payment to the arrival point at which a cancel command arrives.
function driveToCancelPoint(stateDir, cmd, point) {
  if (point === 'BEFORE_POSTED') runCrash(stateDir, cmd, 'FROZEN');
  else if (point === 'AFTER_POSTED') runCrash(stateDir, cmd, 'POSTED');
  else runOk(stateDir, cmd); // AFTER_COMPLETE
}

// ---- Tests ------------------------------------------------------------------
test('clean run: four stages in order, balances and notification correct', () => {
  const dir = mktmp();
  const cert = runOk(dir, payCmd('clean'));
  const expected = expectedCleanRun();
  assert.equal(cert.status, expected.status);
  assert.deepEqual(cert.stages, expected.stages);
  assert.deepEqual(cert.balances, expected.balances);
  assert.equal(cert.notifications, 1);
  // every stage event persisted exactly once, in order
  assert.deepEqual(stageEvents(dir, 'pay-clean').map((e) => e.stage), STAGES);
});

test('crash at every fault point: restart converges to the clean-run final state', () => {
  for (const crashPoint of CRASH_POINTS) {
    const dir = mktmp();
    const cmd = payCmd(`crash-${crashPoint}`);
    const paymentId = cmd.paymentId;

    runCrash(dir, cmd, crashPoint);

    // stage events up to and including the crash point are durable
    const persisted = stageEvents(dir, paymentId).map((e) => e.stage);
    assert.deepEqual(persisted, STAGES.slice(0, STAGES.indexOf(crashPoint) + 1));

    // restart: resume until the workflow completes (idempotent re-recovery)
    let cert = runOk(dir, cmd);
    cert = runOk(dir, cmd); // repeated recovery must be a no-op

    const expected = expectedAfterCrash(crashPoint);
    assert.equal(cert.status, expected.status, `crash at ${crashPoint}`);
    assert.deepEqual(cert.stages, expected.stages, `crash at ${crashPoint}`);
    assert.deepEqual(cert.balances, expected.balances, `crash at ${crashPoint}`);
    // no stage took effect twice
    assert.deepEqual(stageEvents(dir, paymentId).map((e) => e.stage), STAGES);
  }
});

test('cancel at every arrival point: cancel before POST, refund after POST', () => {
  for (const point of CANCEL_POINTS) {
    const dir = mktmp();
    const pay = payCmd(`cancel-${point}`);
    driveToCancelPoint(dir, pay, point);

    const cancelCert = runOk(dir, cancelCmd(`cancel-${point}`, pay.paymentId));
    const expected = expectedAfterCancel(point);
    assert.equal(cancelCert.status, expected.status, `cancel at ${point}`);
    assert.deepEqual(cancelCert.balances, expected.balances, `cancel at ${point}`);

    // resuming the payment afterwards must not continue the workflow
    const resumeCert = runOk(dir, pay);
    assert.equal(resumeCert.status, expected.status, `resume at ${point}`);
    assert.deepEqual(resumeCert.stages, expected.stages, `resume at ${point}`);
    assert.deepEqual(resumeCert.balances, expected.balances, `resume at ${point}`);

    // exactly one terminal accounting event
    const events = readEvents(dir);
    const terminalEvents = events.filter((e) => e.type === 'CANCELLED' || e.type === 'REFUNDED');
    assert.equal(terminalEvents.length, 1, `cancel at ${point}`);
    assert.equal(terminalEvents[0].type, expected.status);
  }
});

test('idempotency: repeated recovery, commands and cancels cause no duplicate accounting', () => {
  const dir = mktmp();
  const pay = payCmd('idem');

  const first = runOk(dir, pay);
  // duplicate: same commandId, same paymentId, and same paymentId/new commandId
  const dupCommand = runOk(dir, pay);
  const dupPayment = runOk(dir, { ...pay, commandId: 'cmd-pay-idem-2' });
  assert.deepEqual(dupCommand, first);
  assert.deepEqual(dupPayment.balances, first.balances);
  assert.equal(stageEvents(dir, pay.paymentId).length, STAGES.length);

  // refund once
  const cancel = cancelCmd('idem', pay.paymentId);
  const refunded = runOk(dir, cancel);
  assert.equal(refunded.status, 'REFUNDED');
  assert.deepEqual(refunded.balances, OPENING);

  // repeated cancel: same commandId and new commandId — no double refund
  const again = runOk(dir, cancel);
  const againNew = runOk(dir, cancelCmd('idem-2', pay.paymentId));
  assert.deepEqual(again.balances, OPENING);
  assert.deepEqual(againNew.balances, OPENING);
  assert.equal(againNew.status, 'REFUNDED');

  const events = readEvents(dir);
  assert.equal(events.filter((e) => e.type === 'REFUNDED').length, 1);
  assert.equal(events.filter((e) => e.type === 'STAGE').length, STAGES.length);

  // recovery on a finished payment is a no-op
  const recovered = runOk(dir, pay);
  assert.deepEqual(recovered.balances, OPENING);
  assert.equal(readEvents(dir).filter((e) => e.type === 'STAGE').length, STAGES.length);
});

test('errors: exit code 1 with an error code', () => {
  const dir = mktmp();

  const badJson = run(dir, 'not-json');
  assert.equal(badJson.status, 1);
  assert.equal(JSON.parse(badJson.stdout).error.code, 'INVALID_COMMAND');

  assert.equal(runErr(dir, { type: 'PAY', commandId: 'x' }).code, 'INVALID_COMMAND');
  assert.equal(runErr(dir, { type: 'PAY', commandId: 'x', paymentId: 'p', amount: -5 }).code, 'INVALID_COMMAND');
  assert.equal(runErr(dir, { type: 'NOPE', commandId: 'x', paymentId: 'p' }).code, 'INVALID_COMMAND');
  assert.equal(runErr(dir, cancelCmd('ghost', 'pay-ghost')).code, 'PAYMENT_NOT_FOUND');

  const badCrash = run(dir, payCmd('badcrash'), 'EXPLODED');
  assert.equal(badCrash.status, 1);
  assert.equal(JSON.parse(badCrash.stdout).error.code, 'INVALID_ARGS');
});

test('insufficient funds: workflow stops at VALIDATED without freezing', () => {
  const dir = mktmp();
  const cert = runOk(dir, payCmd('broke', 100000));
  assert.equal(cert.status, 'FAILED');
  assert.deepEqual(cert.stages, ['VALIDATED']);
  assert.deepEqual(cert.balances, OPENING);
});
