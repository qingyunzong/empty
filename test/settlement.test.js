import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { run } from '../cli.js';
import { createHash } from 'node:crypto';
import {
  createState,
  executeCommand,
  applyEvent,
  replayEvents,
  computeHash,
  initLogDir,
  loadLogDir,
  makeFileEmitter,
  SettlementError,
  EVENTS_FILE,
} from '../src/settlement.js';

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'settle-'));
}

function readEvents(dir) {
  return fs
    .readFileSync(path.join(dir, EVENTS_FILE), 'utf8')
    .split('\n')
    .filter((l) => l.trim() !== '')
    .map((l) => JSON.parse(l));
}

test('normal settlement: balances, event seqs and state hash are correct', () => {
  const dir = tmpDir();
  initLogDir(dir, { merchant: 1000 });
  const state = loadLogDir(dir);
  const cert = executeCommand(
    state,
    { idempotencyKey: 'k1', account: 'merchant', amount: 250 },
    makeFileEmitter(dir),
  );

  assert.equal(cert.status, 'SETTLED');
  assert.deepEqual(cert.balances, { available: 750, frozen: 0 });
  assert.equal(state.accounts.merchant.available, 750);
  assert.equal(state.accounts.merchant.frozen, 0);
  assert.equal(state.settlements.k1.status, 'SETTLED');

  const events = readEvents(dir);
  assert.deepEqual(
    events.map((e) => e.type),
    ['FREEZE', 'PAYABLE_POSTED', 'SETTLED'],
  );
  assert.deepEqual(
    events.map((e) => e.seq),
    [1, 2, 3],
  );
  assert.equal(cert.lastSeq, 3);

  // Hash recomputed independently from canonical serialization.
  const canonical = (v) =>
    Array.isArray(v)
      ? `[${v.map(canonical).join(',')}]`
      : v && typeof v === 'object'
        ? `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${canonical(v[k])}`).join(',')}}`
        : JSON.stringify(v);
  const expectedHash = createHash('sha256')
    .update(canonical({ accounts: state.accounts, settlements: state.settlements, seq: state.seq }))
    .digest('hex');
  assert.equal(cert.hash, expectedHash);
  assert.equal(computeHash(state), expectedHash);

  // Rebuild from log directory yields identical state and hash.
  const rebuilt = loadLogDir(dir);
  assert.equal(computeHash(rebuilt), expectedHash);
  assert.equal(rebuilt.accounts.merchant.available, 750);
});

test('duplicate idempotency key returns original certificate and applies effect once', () => {
  const dir = tmpDir();
  initLogDir(dir, { merchant: 500 });
  const state = loadLogDir(dir);
  const emit = makeFileEmitter(dir);
  const cmd = { idempotencyKey: 'dup', account: 'merchant', amount: 120 };

  const first = executeCommand(state, cmd, emit);
  const second = executeCommand(state, cmd, emit);
  assert.deepEqual(second, first);
  assert.equal(state.accounts.merchant.available, 380);
  assert.equal(readEvents(dir).length, 3);

  // Replaying the old log produces exactly one effect.
  const rebuilt = loadLogDir(dir);
  assert.equal(rebuilt.accounts.merchant.available, 380);
  assert.equal(rebuilt.accounts.merchant.frozen, 0);
  assert.equal(rebuilt.seq, 3);
  assert.equal(computeHash(rebuilt), computeHash(state));

  // A fresh submit against the rebuilt state still returns the original certificate
  // without writing new events.
  const again = executeCommand(rebuilt, cmd, makeFileEmitter(dir));
  assert.deepEqual(again, first);
  assert.equal(readEvents(dir).length, 3);
  assert.equal(rebuilt.accounts.merchant.available, 380);
});

test('failPost: log contains unfreeze compensation, final FAILED, funds restored', () => {
  const dir = tmpDir();
  initLogDir(dir, { merchant: 300 });
  const state = loadLogDir(dir);
  const cert = executeCommand(
    state,
    { idempotencyKey: 'bad', account: 'merchant', amount: 100, failPost: true },
    makeFileEmitter(dir),
  );

  assert.equal(cert.status, 'FAILED');
  assert.deepEqual(cert.balances, { available: 300, frozen: 0 });
  assert.equal(state.settlements.bad.status, 'FAILED');

  const events = readEvents(dir);
  assert.deepEqual(
    events.map((e) => e.type),
    ['FREEZE', 'PAYABLE_FAILED', 'UNFREEZE', 'FAILED'],
  );
  assert.ok(events.some((e) => e.type === 'UNFREEZE'), 'log must contain unfreeze compensation');
  assert.ok(!events.some((e) => e.type === 'SETTLED'), 'must never confirm settlement');

  const rebuilt = loadLogDir(dir);
  assert.equal(rebuilt.accounts.merchant.available, 300);
  assert.equal(rebuilt.accounts.merchant.frozen, 0);
  assert.equal(rebuilt.settlements.bad.status, 'FAILED');
});

test('out-of-order and duplicated events replay to the same state as fresh build', () => {
  const dir = tmpDir();
  initLogDir(dir, { a: 100, b: 50 });
  const state = loadLogDir(dir);
  const emit = makeFileEmitter(dir);
  executeCommand(state, { idempotencyKey: 'x', account: 'a', amount: 40 }, emit);
  executeCommand(state, { idempotencyKey: 'y', account: 'b', amount: 10, failPost: true }, emit);
  executeCommand(state, { idempotencyKey: 'z', account: 'a', amount: 5 }, emit);

  const events = readEvents(dir);
  // Duplicate every event and shuffle deterministically.
  const doubled = [...events, ...events.map((e) => ({ ...e }))];
  const shuffled = doubled
    .map((e, i) => ({ e, key: (i * 7919) % doubled.length }))
    .sort((p, q) => p.key - q.key)
    .map((p) => p.e);

  const replayed = replayEvents(shuffled, { a: 100, b: 50 });
  assert.equal(computeHash(replayed), computeHash(state));
  assert.deepEqual(replayed.accounts, state.accounts);
  assert.deepEqual(replayed.settlements, state.settlements);
  assert.equal(replayed.seq, state.seq);
});

test('illegal transitions and invalid inputs are rejected', () => {
  const state = createState({ m: 100 });
  assert.throws(
    () => applyEvent(state, { seq: 1, type: 'SETTLED', idempotencyKey: 'nope', account: 'm', amount: 1 }),
    (e) => e instanceof SettlementError && e.code === 'ILLEGAL_TRANSITION',
  );
  assert.throws(
    () => executeCommand(state, { idempotencyKey: 'k', account: 'm', amount: 3.5 }, () => {}),
    (e) => e.code === 'INVALID_INPUT',
  );
  assert.throws(
    () => executeCommand(state, { idempotencyKey: 'k', account: 'ghost', amount: 1 }, () => {}),
    (e) => e.code === 'UNKNOWN_ACCOUNT',
  );
  assert.throws(
    () => executeCommand(state, { idempotencyKey: 'k', account: 'm', amount: 1000 }, () => {}),
    (e) => e.code === 'INSUFFICIENT_FUNDS',
  );
  // Settled settlement cannot transition further.
  const s2 = createState({ m: 100 });
  executeCommand(s2, { idempotencyKey: 'done', account: 'm', amount: 10 }, () => {});
  assert.throws(
    () => applyEvent(s2, { seq: 4, type: 'UNFREEZE', idempotencyKey: 'done', account: 'm', amount: 10 }),
    (e) => e.code === 'ILLEGAL_TRANSITION',
  );
});

// --- Independent enumerator: does not reference the library under test. ---

function enumerateModel(accounts, commands, order) {
  const balances = {};
  for (const [name, amount] of Object.entries(accounts)) {
    balances[name] = { available: amount, frozen: 0 };
  }
  const seen = new Set();
  const finalStatus = {};
  for (const index of order) {
    const cmd = commands[index];
    if (seen.has(cmd.idempotencyKey)) continue;
    seen.add(cmd.idempotencyKey);
    const acct = balances[cmd.account];
    if (!acct || acct.available < cmd.amount) {
      finalStatus[cmd.idempotencyKey] = 'REJECTED';
      continue;
    }
    acct.available -= cmd.amount;
    acct.frozen += cmd.amount;
    if (cmd.failPost === true) {
      acct.frozen -= cmd.amount;
      acct.available += cmd.amount;
      finalStatus[cmd.idempotencyKey] = 'FAILED';
    } else {
      acct.frozen -= cmd.amount;
      finalStatus[cmd.idempotencyKey] = 'SETTLED';
    }
  }
  return { balances, finalStatus };
}

function permutations(n) {
  if (n <= 1) return [[...Array(n).keys()]];
  const sub = permutations(n - 1);
  const result = [];
  for (const perm of sub) {
    for (let i = 0; i <= perm.length; i += 1) {
      result.push([...perm.slice(0, i), n - 1, ...perm.slice(i)]);
    }
  }
  return result;
}

test('enumerator: all arrival orders of three commands produce matching balances', () => {
  const accounts = { merchant: 100 };
  const commands = [
    { idempotencyKey: 'c1', account: 'merchant', amount: 40 },
    { idempotencyKey: 'c2', account: 'merchant', amount: 70 },
    { idempotencyKey: 'c3', account: 'merchant', amount: 30, failPost: true },
  ];
  const orders = permutations(commands.length);
  assert.equal(orders.length, 6);

  for (const order of orders) {
    const expected = enumerateModel(accounts, commands, order);

    const dir = tmpDir();
    initLogDir(dir, accounts);
    const state = loadLogDir(dir);
    const emit = makeFileEmitter(dir);
    const actualStatus = {};
    for (const index of order) {
      const cmd = commands[index];
      try {
        actualStatus[cmd.idempotencyKey] = executeCommand(state, cmd, emit).status;
      } catch (e) {
        assert.equal(e.code, 'INSUFFICIENT_FUNDS');
        actualStatus[cmd.idempotencyKey] = 'REJECTED';
      }
    }

    assert.deepEqual(
      { available: state.accounts.merchant.available, frozen: state.accounts.merchant.frozen },
      expected.balances.merchant,
      `order ${order} balances`,
    );
    assert.deepEqual(actualStatus, expected.finalStatus, `order ${order} statuses`);

    // Replaying the persisted log must agree with the live run.
    const rebuilt = loadLogDir(dir);
    assert.deepEqual(rebuilt.accounts, state.accounts, `order ${order} replay`);
    assert.equal(computeHash(rebuilt), computeHash(state));
  }
});

// --- CLI end-to-end (driven in-process; the sandbox forbids child processes) ---

function cli(argv) {
  let out = '';
  const code = run(argv, (text) => {
    out += text;
  });
  return { code, json: JSON.parse(out) };
}

test('CLI: init, submit, rebuild, duplicate and error contract', () => {
  const dir = tmpDir();
  const accountsFile = path.join(dir, 'in-accounts.json');
  fs.writeFileSync(accountsFile, JSON.stringify({ shop: 200 }));

  assert.equal(cli(['init', dir, accountsFile]).code, 0);

  const cmdFile = path.join(dir, 'cmd.json');
  fs.writeFileSync(cmdFile, JSON.stringify({ idempotencyKey: 'cli-1', account: 'shop', amount: 80 }));
  const out1 = cli(['submit', dir, cmdFile]);
  assert.equal(out1.code, 0);
  assert.equal(out1.json.status, 'SETTLED');
  assert.equal(out1.json.balances.available, 120);

  // Duplicate submission returns the same certificate, no extra effect.
  const out2 = cli(['submit', dir, cmdFile]);
  assert.equal(out2.code, 0);
  assert.deepEqual(out2.json, out1.json);

  const rebuilt = cli(['rebuild', dir]);
  assert.equal(rebuilt.code, 0);
  assert.equal(rebuilt.json.accounts.shop.available, 120);
  assert.equal(rebuilt.json.accounts.shop.frozen, 0);
  assert.equal(rebuilt.json.seq, 3);
  assert.equal(rebuilt.json.hash, out1.json.hash);
  assert.equal(rebuilt.json.settlements['cli-1'].status, 'SETTLED');

  // Error contract: exit code 1 and {"error":"CODE","message":"..."}.
  const badFile = path.join(dir, 'bad.json');
  fs.writeFileSync(badFile, JSON.stringify({ idempotencyKey: 'cli-2', account: 'shop', amount: 99999 }));
  const err = cli(['submit', dir, badFile]);
  assert.equal(err.code, 1);
  assert.equal(err.json.error, 'INSUFFICIENT_FUNDS');
  assert.equal(typeof err.json.message, 'string');

  const missing = cli(['submit', dir, path.join(dir, 'missing.json')]);
  assert.equal(missing.code, 1);
  assert.equal(missing.json.error, 'INVALID_INPUT');

  const notInit = cli(['rebuild', path.join(dir, 'nope')]);
  assert.equal(notInit.code, 1);
  assert.equal(notInit.json.error, 'NOT_INITIALIZED');
});
