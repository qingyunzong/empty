import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const CLI = path.join(ROOT, 'cli.js');
const TMP = fs.mkdtempSync(path.join('/tmp', 'paywf-test-'));

// ---- Independent enumerators: fault points and cancel arrival points ----
const STAGES = ['VALIDATED', 'FROZEN', 'POSTED', 'NOTIFIED'];
const FAULT_POINTS = [...STAGES];
const CANCEL_POINTS = ['AFTER_VALIDATED', 'AFTER_FROZEN', 'AFTER_POSTED'];

// Where to pause the workflow so that a cancel arrives at each point.
const PAUSE_BEFORE_STAGE = {
  AFTER_VALIDATED: 'FROZEN',
  AFTER_FROZEN: 'POSTED',
  AFTER_POSTED: 'NOTIFIED',
};

const INITIAL_BALANCE = 1000;
const AMOUNT = 100;

// Directly derived expected terminal states (independent of implementation).
function expectedAfterCrashAndRecovery() {
  return { status: 'COMPLETED', stages: [...STAGES], balance: INITIAL_BALANCE - AMOUNT, frozen: 0 };
}

function expectedAfterCancel(cancelPoint) {
  const posted = cancelPoint === 'AFTER_POSTED';
  return {
    status: posted ? 'REFUNDED' : 'CANCELLED',
    balance: INITIAL_BALANCE,
    frozen: 0,
  };
}

// ---- Helpers ----
let dirCounter = 0;
function freshStateDir() {
  dirCounter += 1;
  return path.join(TMP, `case-${dirCounter}`);
}

// The sandboxed environment denies pipe-based stdio for grandchild
// processes, so child output is captured via a redirected file instead.
let outCounter = 0;
function runCli(command, stateDir) {
  outCounter += 1;
  const outFile = path.join(TMP, `out-${outCounter}.txt`);
  const fd = fs.openSync(outFile, 'w');
  let result;
  try {
    result = spawnSync('node', [CLI, JSON.stringify(command), stateDir], {
      stdio: ['ignore', fd, fd],
    });
  } finally {
    fs.closeSync(fd);
  }
  const stdout = fs.readFileSync(outFile, 'utf8').trim();
  return {
    status: result.status,
    json: stdout.length > 0 ? JSON.parse(stdout.split('\n').pop()) : null,
    stderr: '',
  };
}

function runCliRaw(args) {
  outCounter += 1;
  const outFile = path.join(TMP, `out-${outCounter}.txt`);
  const fd = fs.openSync(outFile, 'w');
  let result;
  try {
    result = spawnSync('node', args, { stdio: ['ignore', fd, fd] });
  } finally {
    fs.closeSync(fd);
  }
  return { status: result.status, stdout: fs.readFileSync(outFile, 'utf8') };
}

function payCommand(overrides = {}) {
  return {
    type: 'pay',
    paymentId: 'p1',
    commandId: 'cmd-pay-1',
    amount: AMOUNT,
    initialBalance: INITIAL_BALANCE,
    ...overrides,
  };
}

function readLog(stateDir) {
  const file = path.join(stateDir, 'events.log');
  if (!fs.existsSync(file)) return [];
  return fs
    .readFileSync(file, 'utf8')
    .split('\n')
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line));
}

function countEvents(events, type, stage) {
  return events.filter((e) => e.type === type && (stage === undefined || e.stage === stage)).length;
}

// ---- Tests ----

test('no fault: four stages execute in fixed order', () => {
  const dir = freshStateDir();
  const run = runCli(payCommand(), dir);
  assert.equal(run.status, 0, run.stderr);
  assert.deepEqual(run.json.stages, STAGES);
  assert.equal(run.json.status, 'COMPLETED');
  assert.equal(run.json.balance, INITIAL_BALANCE - AMOUNT);
  assert.equal(run.json.frozen, 0);

  const events = readLog(dir);
  const begins = events.filter((e) => e.type === 'STAGE_BEGIN').map((e) => e.stage);
  assert.deepEqual(begins, STAGES, 'stage events persisted in order before effects');
  for (const stage of STAGES) {
    const beginIdx = events.findIndex((e) => e.type === 'STAGE_BEGIN' && e.stage === stage);
    const doneIdx = events.findIndex((e) => e.type === 'STAGE_DONE' && e.stage === stage);
    assert.ok(beginIdx !== -1 && doneIdx !== -1 && beginIdx < doneIdx, `${stage}: begin persisted before apply`);
  }
});

test('fault points: kill at each crashPoint, restart, final balance and stage set consistent', async (t) => {
  for (const faultPoint of FAULT_POINTS) {
    await t.test(`crash after persisting ${faultPoint} event`, () => {
      const dir = freshStateDir();
      const expected = expectedAfterCrashAndRecovery();

      const crashed = runCli(payCommand({ crashPoint: faultPoint }), dir);
      assert.equal(crashed.status, 99, 'crash exit code');
      assert.equal(crashed.json.crash, faultPoint);

      // Event for the fault stage was persisted, but its effect was not applied.
      const eventsAfterCrash = readLog(dir);
      assert.equal(countEvents(eventsAfterCrash, 'STAGE_BEGIN', faultPoint), 1);
      assert.equal(countEvents(eventsAfterCrash, 'STAGE_DONE', faultPoint), 0);

      const recovered = runCli(payCommand(), dir);
      assert.equal(recovered.status, 0, recovered.stderr);
      assert.equal(recovered.json.status, expected.status);
      assert.deepEqual(recovered.json.stages, expected.stages);
      assert.equal(recovered.json.balance, expected.balance);
      assert.equal(recovered.json.frozen, expected.frozen);

      // No stage took effect twice.
      const events = readLog(dir);
      for (const stage of STAGES) {
        assert.equal(countEvents(events, 'STAGE_DONE', stage), 1, `${stage} applied exactly once`);
      }

      // Repeated recovery is a no-op: identical certificate, no new accounting.
      const again = runCli(payCommand(), dir);
      assert.equal(again.status, 0);
      assert.deepEqual(again.json, recovered.json);
      assert.deepEqual(readLog(dir), events);
    });
  }
});

test('cancel arrival points: before POST cancels and releases freeze; after POST refunds', async (t) => {
  for (const cancelPoint of CANCEL_POINTS) {
    await t.test(`cancel arriving ${cancelPoint}`, () => {
      const dir = freshStateDir();
      const expected = expectedAfterCancel(cancelPoint);

      const paused = runCli(payCommand({ pauseBefore: PAUSE_BEFORE_STAGE[cancelPoint] }), dir);
      assert.equal(paused.status, 0, paused.stderr);
      assert.equal(paused.json.status, 'IN_PROGRESS');

      const cancelCmd = { type: 'cancel', paymentId: 'p1', commandId: 'cmd-cancel-1' };
      const cancelled = runCli(cancelCmd, dir);
      assert.equal(cancelled.status, 0, cancelled.stderr);
      assert.equal(cancelled.json.status, expected.status);
      assert.equal(cancelled.json.balance, expected.balance);
      assert.equal(cancelled.json.frozen, expected.frozen);

      const terminalEvent = cancelPoint === 'AFTER_POSTED' ? 'REFUNDED' : 'CANCELLED';
      assert.equal(countEvents(readLog(dir), terminalEvent), 1);

      // Resuming the payment after a terminal cancel/refund is a no-op.
      const resumed = runCli(payCommand(), dir);
      assert.equal(resumed.status, 0);
      assert.deepEqual(resumed.json, cancelled.json);

      // Repeated cancel (same commandId) and duplicate cancel (new commandId)
      // produce no duplicate accounting.
      const repeat = runCli(cancelCmd, dir);
      assert.equal(repeat.status, 0);
      assert.deepEqual(repeat.json, cancelled.json);

      const duplicate = runCli({ ...cancelCmd, commandId: 'cmd-cancel-2' }, dir);
      assert.equal(duplicate.status, 0);
      assert.deepEqual(duplicate.json, cancelled.json);

      const events = readLog(dir);
      assert.equal(countEvents(events, terminalEvent), 1, 'exactly one terminal event');
      assert.equal(countEvents(events, 'CANCELLED') + countEvents(events, 'REFUNDED'), 1);
    });
  }
});

test('idempotency: repeated pay command does not duplicate accounting', () => {
  const dir = freshStateDir();
  const first = runCli(payCommand(), dir);
  assert.equal(first.status, 0);
  const eventsAfterFirst = readLog(dir);

  const second = runCli(payCommand(), dir);
  assert.equal(second.status, 0);
  assert.deepEqual(second.json, first.json);
  assert.deepEqual(readLog(dir), eventsAfterFirst, 'no new events appended');
});

test('errors: exit code 1 with error code', () => {
  const dir = freshStateDir();

  const badJson = runCliRaw([CLI, '{not json', dir]);
  assert.equal(badJson.status, 1);
  assert.equal(JSON.parse(badJson.stdout.trim()).error, 'INVALID_INPUT');

  const missingArgs = runCliRaw([CLI]);
  assert.equal(missingArgs.status, 1);
  assert.equal(JSON.parse(missingArgs.stdout.trim()).error, 'INVALID_INPUT');

  const unknownType = runCli({ type: 'explode', commandId: 'c1', paymentId: 'p9' }, dir);
  assert.equal(unknownType.status, 1);
  assert.equal(unknownType.json.error, 'INVALID_COMMAND');

  const notFound = runCli({ type: 'cancel', paymentId: 'nope', commandId: 'c2' }, dir);
  assert.equal(notFound.status, 1);
  assert.equal(notFound.json.error, 'PAYMENT_NOT_FOUND');

  const poor = runCli(payCommand({ paymentId: 'p2', commandId: 'c3', initialBalance: 10 }), dir);
  assert.equal(poor.status, 1);
  assert.equal(poor.json.error, 'INSUFFICIENT_FUNDS');

  runCli(payCommand(), dir);
  const conflict = runCli(payCommand({ commandId: 'different-cmd' }), dir);
  assert.equal(conflict.status, 1);
  assert.equal(conflict.json.error, 'DUPLICATE_PAYMENT');
});
