import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { Ledger, LedgerError } from '../src/ledger.js';

const REPORT_FILE = new URL('../test-report.log', import.meta.url);

function report(record) {
  fs.appendFileSync(REPORT_FILE, JSON.stringify(record) + '\n');
}

class ExitIntercepted extends Error {
  constructor(code) {
    super(`process.exit(${code})`);
    this.exitCode = code;
  }
}

// Runs fn with process.exit stubbed; returns the exit code the ledger tried to
// use, or null when no exit was requested. The stub turns a real process crash
// into a catchable in-process crash so node:test can observe it (the sandbox
// forbids spawning child node processes).
function captureCrash(fn) {
  const original = process.exit;
  process.exit = (code) => {
    throw new ExitIntercepted(code);
  };
  try {
    fn();
    return null;
  } catch (error) {
    if (error instanceof ExitIntercepted) {
      return error.exitCode;
    }
    throw error;
  } finally {
    process.exit = original;
  }
}

function tmpFile(name) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ledger-accept-'));
  return path.join(dir, name);
}

test('acceptance 1: reserve crashes afterAppend (exit 42), hold survives restart, commit succeeds', (t) => {
  const file = tmpFile('log.jsonl');

  const crashing = Ledger.open(file, {
    crash: { phase: 'afterAppend', at: 0 },
    exitOnCrash: true,
  });
  const exitCode = captureCrash(() => crashing.reserve('alice', 100, 'r1'));
  assert.equal(exitCode, 42, 'afterAppend crash must exit with code 42');

  const reopened = Ledger.open(file);
  t.diagnostic(`recovery report: ${JSON.stringify(reopened.recovery)}`);
  t.diagnostic(`lastHash: ${reopened.lastHash}`);
  report({
    test: 'acceptance-1',
    crashExitCode: exitCode,
    recovery: reopened.recovery,
    lastHash: reopened.lastHash,
    accounts: reopened.state(),
  });
  assert.equal(reopened.recovery.truncated, false);
  assert.equal(reopened.events.length, 1, 'event must be persisted despite the crash');
  assert.equal(reopened.state().alice.held, 100);
  assert.equal(reopened.state().alice.available, 900);

  const commit = reopened.commit('alice', 100, 'c1');
  assert.equal(commit.applied, true);
  assert.equal(reopened.state().alice.held, 0);
  assert.equal(reopened.state().alice.limit, 900);

  const final = Ledger.open(file);
  assert.equal(final.state().alice.held, 0);
  assert.equal(final.events.length, 2);
  t.diagnostic(`final lastHash: ${final.lastHash}`);
});

test('acceptance 2: beforeAppend crash leaves no partial write, duplicate eventId never double-charges', (t) => {
  const file = tmpFile('log.jsonl');

  const ledger = Ledger.open(file);
  ledger.reserve('bob', 50, 'r1');
  const bytesBefore = fs.readFileSync(file);

  const crashing = Ledger.open(file, {
    crash: { phase: 'beforeAppend', at: 0 },
    exitOnCrash: true,
  });
  const exitCode = captureCrash(() => crashing.commit('bob', 50, 'c1'));
  assert.equal(exitCode, 1, 'beforeAppend crash exits with code 1');
  assert.deepEqual(fs.readFileSync(file), bytesBefore, 'log must be byte-identical after beforeAppend crash');

  const restarted = Ledger.open(file);
  assert.equal(restarted.events.length, 1, 'crashed event must not exist');
  assert.equal(restarted.state().bob.held, 50);

  const first = restarted.commit('bob', 50, 'c1');
  assert.equal(first.applied, true);
  assert.equal(restarted.state().bob.held, 0);
  assert.equal(restarted.state().bob.limit, 950);

  const second = restarted.commit('bob', 50, 'c1');
  assert.equal(second.applied, false);
  assert.equal(second.duplicate, true);
  assert.equal(restarted.state().bob.held, 0, 'duplicate eventId must not deduct again');
  assert.equal(restarted.state().bob.limit, 950);

  const dupReserve = restarted.reserve('bob', 50, 'r1');
  assert.equal(dupReserve.duplicate, true);
  assert.equal(restarted.state().bob.available, 950);

  const final = Ledger.open(file);
  t.diagnostic(`recovery report: ${JSON.stringify(final.recovery)}`);
  t.diagnostic(`lastHash: ${final.lastHash}`);
  report({
    test: 'acceptance-2',
    crashExitCode: exitCode,
    recovery: final.recovery,
    lastHash: final.lastHash,
    accounts: final.state(),
  });
  assert.equal(final.events.length, 2, 'only two unique events exist');
});

test('acceptance 3: tampered last line is truncated and recovery reports the position', (t) => {
  const file = tmpFile('log.jsonl');

  const ledger = Ledger.open(file);
  ledger.reserve('carol', 10, 'e1');
  ledger.reserve('carol', 20, 'e2');
  ledger.reserve('carol', 30, 'e3');
  const hashOfSecond = ledger.events[1].hash;

  const original = fs.readFileSync(file);
  const lines = original.toString('utf8').split('\n').filter((line) => line.length > 0);
  const offsetOfLastLine = original.length - Buffer.byteLength(lines[2] + '\n');

  const tampered = Buffer.from(original);
  const amountAt = lines[2].indexOf('"amount":30') + '"amount":'.length;
  tampered[offsetOfLastLine + amountAt] = '9'.charCodeAt(0); // 30 -> 90
  fs.writeFileSync(file, tampered);

  const recovered = Ledger.open(file);
  t.diagnostic(`recovery report: ${JSON.stringify(recovered.recovery)}`);
  t.diagnostic(`lastHash: ${recovered.lastHash}`);
  report({
    test: 'acceptance-3',
    recovery: recovered.recovery,
    lastHash: recovered.lastHash,
    accounts: recovered.state(),
  });
  assert.equal(recovered.recovery.truncated, true);
  assert.equal(
    recovered.recovery.byteOffset,
    offsetOfLastLine,
    'truncation position must be the start of the corrupt record',
  );
  assert.equal(recovered.recovery.line, 2);
  assert.equal(recovered.events.length, 2);
  assert.equal(recovered.state().carol.held, 30, 'only the first two events survive');
  assert.equal(recovered.lastHash, hashOfSecond);
  assert.equal(fs.statSync(file).size, offsetOfLastLine, 'file must be physically truncated');

  const next = recovered.commit('carol', 10, 'c1');
  assert.equal(next.event.seq, 2, 'log continues with correct seq after truncation');
  assert.equal(next.event.prevHash, hashOfSecond, 'chain continues from the truncation point');
});

test('tampered middle line truncates it and everything after', (t) => {
  const file = tmpFile('log.jsonl');
  const ledger = Ledger.open(file);
  ledger.reserve('mid', 10, 'e1');
  ledger.reserve('mid', 10, 'e2');
  ledger.reserve('mid', 10, 'e3');

  const original = fs.readFileSync(file);
  const lines = original.toString('utf8').split('\n').filter((line) => line.length > 0);
  const offsetOfMiddle = Buffer.byteLength(lines[0] + '\n');
  const tampered = Buffer.from(original);
  const accountAt = lines[1].indexOf('"account":"mid"') + '"account":"'.length;
  tampered[offsetOfMiddle + accountAt] = 'X'.charCodeAt(0);
  fs.writeFileSync(file, tampered);

  const recovered = Ledger.open(file);
  t.diagnostic(`recovery report: ${JSON.stringify(recovered.recovery)}`);
  report({ test: 'tamper-middle', recovery: recovered.recovery, lastHash: recovered.lastHash });
  assert.equal(recovered.recovery.truncated, true);
  assert.equal(recovered.recovery.byteOffset, offsetOfMiddle);
  assert.equal(recovered.events.length, 1);
  assert.equal(recovered.state().mid.held, 10);
});

test('frozen account rejects new reserve but still allows commit and release', () => {
  const file = tmpFile('log.jsonl');
  const ledger = Ledger.open(file);
  ledger.reserve('dave', 40, 'r1');
  ledger.freeze('dave', 'f1');

  assert.throws(() => ledger.reserve('dave', 10, 'r2'), (error) => {
    assert.equal(error.code, 'ACCOUNT_FROZEN');
    return true;
  });
  assert.equal(ledger.events.length, 2, 'rejected reserve must not append');

  ledger.commit('dave', 15, 'c1');
  assert.equal(ledger.state().dave.held, 25);
  ledger.release('dave', 25, 'r3');
  assert.equal(ledger.state().dave.held, 0);
  assert.equal(ledger.state().dave.available, 985);
});

test('release cannot touch already-committed holds', () => {
  const file = tmpFile('log.jsonl');
  const ledger = Ledger.open(file);
  ledger.reserve('erin', 30, 'r1');
  ledger.commit('erin', 30, 'c1');
  assert.throws(() => ledger.release('erin', 1, 'r2'), (error) => {
    assert.ok(error instanceof LedgerError);
    assert.equal(error.code, 'INSUFFICIENT_HELD');
    return true;
  });
});
