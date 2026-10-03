import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

import { TradingEngine, TradingError, DEFAULT_BALANCE, EVENTS_FILE } from '../src/engine.js';

const CLI = path.resolve('cli.js');
const AMOUNT = 2500;

async function tmpdir() {
  return fs.mkdtemp(path.join(os.tmpdir(), 'trade-saga-'));
}

function instruction(tradeId, overrides = {}) {
  return {
    id: `ins-${tradeId}`,
    type: 'instruction',
    tradeId,
    amount: AMOUNT,
    riskResult: 'pass',
    accountResult: 'pass',
    ...overrides,
  };
}

async function readLog(workdir) {
  const text = await fs.readFile(path.join(workdir, EVENTS_FILE), 'utf8');
  return text.split('\n').filter((line) => line.trim()).map((line) => JSON.parse(line));
}

// ---------------------------------------------------------------------------
// Independent enumerator: 4 branch-result combos x 2 fault points.
// ---------------------------------------------------------------------------

const RISK_RESULTS = ['pass', 'reject'];
const ACCOUNT_RESULTS = ['pass', 'insufficient'];
const FAULT_POINTS = ['none', 'crashBeforeConfirm'];

const expectedFinal = (risk, account) => {
  if (risk === 'pass' && account === 'pass') {
    return { status: 'filled', available: DEFAULT_BALANCE - AMOUNT, frozen: 0 };
  }
  return { status: 'cancelled', available: DEFAULT_BALANCE, frozen: 0 };
};

for (const risk of RISK_RESULTS) {
  for (const account of ACCOUNT_RESULTS) {
    for (const fault of FAULT_POINTS) {
      test(`enumerator: risk=${risk} account=${account} fault=${fault}`, async () => {
        const dir = await tmpdir();
        const want = expectedFinal(risk, account);
        const crash = fault === 'crashBeforeConfirm';

        let engine = await TradingEngine.open(dir);
        const first = await engine.submit(instruction('T1', {
          riskResult: risk,
          accountResult: account,
          crashBeforeConfirm: crash,
        }));

        if (crash) {
          // Both branches persisted, confirm must not have happened.
          assert.equal(first.crashed, true);
          assert.equal(first.tradeStatus, 'pending');
          const log = await readLog(dir);
          assert.deepEqual(log.map((e) => e.type), ['instruction', 'risk', 'account']);
          const mid = engine.snapshot();
          assert.equal(mid.balances.frozen, account === 'pass' ? AMOUNT : 0);
          assert.equal(mid.balances.available, DEFAULT_BALANCE - (account === 'pass' ? AMOUNT : 0));

          // Restart and recover; duplicate restarts must not change the outcome.
          for (let round = 0; round < 2; round += 1) {
            engine = await TradingEngine.open(dir);
            const cert = await engine.recover();
            if (round === 0) assert.deepEqual(cert.joined, ['T1']);
            else assert.deepEqual(cert.joined, []);
          }
        } else {
          assert.equal(first.crashed, false);
          assert.equal(first.tradeStatus, want.status);
        }

        const state = engine.snapshot();
        assert.equal(state.trades.T1.status, want.status);
        assert.equal(state.balances.available, want.available);
        assert.equal(state.balances.frozen, 0);

        // Confirm must have been persisted exactly once.
        const log = await readLog(dir);
        assert.equal(log.filter((e) => e.type === 'confirm').length, 1);

        // Hash must be stable across a fresh replay of the same log.
        const replayed = await TradingEngine.open(dir);
        assert.equal(replayed.stateHash(), engine.stateHash());
      });
    }
  }
}

// ---------------------------------------------------------------------------
// Acceptance scenarios.
// ---------------------------------------------------------------------------

test('both branches pass -> trade filled, funds settled', async () => {
  const dir = await tmpdir();
  const engine = await TradingEngine.open(dir);
  const cert = await engine.submit(instruction('T-fill'));
  assert.equal(cert.tradeStatus, 'filled');
  assert.deepEqual(cert.balances, { available: DEFAULT_BALANCE - AMOUNT, frozen: 0 });
  assert.match(cert.stateHash, /^[0-9a-f]{64}$/);
});

test('risk rejected -> cancelled and freeze released', async () => {
  const dir = await tmpdir();
  const engine = await TradingEngine.open(dir);
  const cert = await engine.submit(instruction('T-risk', { riskResult: 'reject' }));
  assert.equal(cert.tradeStatus, 'cancelled');
  assert.deepEqual(cert.balances, { available: DEFAULT_BALANCE, frozen: 0 });
});

test('account insufficient -> cancelled, nothing frozen', async () => {
  const dir = await tmpdir();
  const engine = await TradingEngine.open(dir);
  const cert = await engine.submit(instruction('T-acct', { accountResult: 'insufficient' }));
  assert.equal(cert.tradeStatus, 'cancelled');
  assert.deepEqual(cert.balances, { available: DEFAULT_BALANCE, frozen: 0 });
});

test('confirm with only one branch arrived must fail', async () => {
  const dir = await tmpdir();
  const engine = await TradingEngine.open(dir);
  await engine.submit(instruction('T-one', { manualBranches: true }));
  await engine.submit({ id: 'risk-1', type: 'risk', tradeId: 'T-one' });

  await assert.rejects(
    () => engine.submit({ id: 'confirm-1', type: 'confirm', tradeId: 'T-one' }),
    (err) => err instanceof TradingError && err.code === 'CONFIRM_NOT_READY',
  );

  const state = engine.snapshot();
  assert.equal(state.trades['T-one'].status, 'pending');
  const log = await readLog(dir);
  assert.equal(log.filter((e) => e.type === 'confirm').length, 0);
});

test('out-of-order and duplicate branch arrivals do not change the outcome', async () => {
  const dir = await tmpdir();
  const engine = await TradingEngine.open(dir);
  await engine.submit(instruction('T-ooo', { manualBranches: true }));

  // Account branch arrives before risk branch.
  await engine.submit({ id: 'acct-1', type: 'account', tradeId: 'T-ooo' });
  let state = engine.snapshot();
  assert.equal(state.trades['T-ooo'].status, 'pending');
  assert.equal(state.balances.frozen, AMOUNT);

  // Exact duplicate (same tradeId + event id) is a no-op.
  const dup = await engine.submit({ id: 'acct-1', type: 'account', tradeId: 'T-ooo' });
  assert.equal(dup.duplicate, true);
  assert.equal(dup.applied, false);

  // Same branch with a different id is applied to the log but ignored by replay:
  // no double freeze.
  await engine.submit({ id: 'acct-2', type: 'account', tradeId: 'T-ooo' });
  state = engine.snapshot();
  assert.equal(state.balances.frozen, AMOUNT);
  assert.equal(state.balances.available, DEFAULT_BALANCE - AMOUNT);

  // Risk branch completes the join.
  const done = await engine.submit({ id: 'risk-1', type: 'risk', tradeId: 'T-ooo' });
  assert.equal(done.tradeStatus, 'filled');
  assert.deepEqual(engine.snapshot().balances, { available: DEFAULT_BALANCE - AMOUNT, frozen: 0 });

  // Duplicates after completion are still no-ops.
  const after = engine.stateHash();
  await engine.submit({ id: 'risk-1', type: 'risk', tradeId: 'T-ooo' });
  await engine.submit({ id: 'risk-2', type: 'risk', tradeId: 'T-ooo' });
  assert.equal(engine.stateHash(), after);
});

test('duplicate instruction with same id is idempotent, different id rejected', async () => {
  const dir = await tmpdir();
  const engine = await TradingEngine.open(dir);
  await engine.submit(instruction('T-dup'));
  const hash = engine.stateHash();

  const again = await engine.submit(instruction('T-dup'));
  assert.equal(again.duplicate, true);
  assert.equal(engine.stateHash(), hash);

  await assert.rejects(
    () => engine.submit(instruction('T-dup', { id: 'ins-other' })),
    (err) => err.code === 'DUPLICATE_TRADE',
  );
  assert.equal(engine.stateHash(), hash);
});

test('duplicate restarts after crash confirm exactly once', async () => {
  const dir = await tmpdir();
  let engine = await TradingEngine.open(dir);
  await engine.submit(instruction('T-crash', { crashBeforeConfirm: true }));

  const hashes = new Set();
  for (let i = 0; i < 3; i += 1) {
    engine = await TradingEngine.open(dir);
    await engine.recover();
    hashes.add(engine.stateHash());
  }
  assert.equal(hashes.size, 1);
  assert.equal(engine.snapshot().trades['T-crash'].status, 'filled');

  const log = await readLog(dir);
  assert.equal(log.filter((e) => e.type === 'confirm').length, 1);
});

test('unknown trade and unknown event type are rejected', async () => {
  const dir = await tmpdir();
  const engine = await TradingEngine.open(dir);
  await assert.rejects(
    () => engine.submit({ id: 'x', type: 'confirm', tradeId: 'nope' }),
    (err) => err.code === 'TRADE_NOT_FOUND',
  );
  await assert.rejects(
    () => engine.submit({ id: 'x', type: 'refund', tradeId: 'nope' }),
    (err) => err.code === 'UNKNOWN_EVENT_TYPE',
  );
});

// ---------------------------------------------------------------------------
// CLI contract.
// ---------------------------------------------------------------------------

// Note: in this sandbox a node process spawned directly by node loses its
// piped stdout, so capture via shell redirection to files instead.
async function runCli(args, input) {
  const dir = await tmpdir();
  const outFile = path.join(dir, 'out.txt');
  const errFile = path.join(dir, 'err.txt');
  const codeFile = path.join(dir, 'code.txt');
  const quote = (value) => `'${String(value).replace(/'/g, `'\\''`)}'`;
  let command = `node ${[CLI, ...args].map(quote).join(' ')} > ${quote(outFile)} 2> ${quote(errFile)}`;
  if (input !== undefined) {
    const inFile = path.join(dir, 'in.txt');
    await fs.writeFile(inFile, input);
    command += ` < ${quote(inFile)}`;
  }
  command += `; echo $? > ${quote(codeFile)}`;
  spawnSync('sh', ['-c', command]);
  const code = Number((await fs.readFile(codeFile, 'utf8')).trim());
  const stdout = await fs.readFile(outFile, 'utf8');
  const stderr = await fs.readFile(errFile, 'utf8');
  return { code, stdout, stderr };
}

test('CLI emits a JSON certificate with a state hash', async () => {
  const dir = await tmpdir();
  const event = JSON.stringify(instruction('T-cli'));
  const { code, stdout } = await runCli([dir, event]);
  assert.equal(code, 0);
  const cert = JSON.parse(stdout);
  assert.equal(cert.status, 'ok');
  assert.equal(cert.tradeStatus, 'filled');
  assert.match(cert.stateHash, /^[0-9a-f]{64}$/);
  assert.deepEqual(cert.balances, { available: DEFAULT_BALANCE - AMOUNT, frozen: 0 });
});

test('CLI reads the event from stdin when given "-"', async () => {
  const dir = await tmpdir();
  const { code, stdout } = await runCli([dir, '-'], JSON.stringify(instruction('T-stdin')));
  assert.equal(code, 0);
  assert.equal(JSON.parse(stdout).tradeStatus, 'filled');
});

test('CLI exits 1 with {"error","message"} on invalid JSON', async () => {
  const dir = await tmpdir();
  const { code, stdout } = await runCli([dir, '{not json']);
  assert.equal(code, 1);
  const body = JSON.parse(stdout);
  assert.equal(body.error, 'INVALID_JSON');
  assert.equal(typeof body.message, 'string');
});

test('CLI exits 1 with CONFIRM_NOT_READY when branches are missing', async () => {
  const dir = await tmpdir();
  const setup = await runCli([dir, JSON.stringify(instruction('T-cli-manual', { manualBranches: true }))]);
  assert.equal(setup.code, 0);
  const { code, stdout } = await runCli([dir, JSON.stringify({ id: 'c1', type: 'confirm', tradeId: 'T-cli-manual' })]);
  assert.equal(code, 1);
  const body = JSON.parse(stdout);
  assert.equal(body.error, 'CONFIRM_NOT_READY');
});

test('CLI exits 1 with USAGE when arguments are missing', async () => {
  const { code, stdout } = await runCli([]);
  assert.equal(code, 1);
  const body = JSON.parse(stdout);
  assert.equal(body.error, 'USAGE');
  assert.equal(typeof body.message, 'string');
});
