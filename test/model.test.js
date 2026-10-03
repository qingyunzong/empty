import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { Ledger, LedgerError, CrashError, GENESIS_HASH, hashEvent } from '../src/ledger.js';

const LIMIT = 100;

// ---------------------------------------------------------------------------
// Independent sequential reference model. Shares no code with src/ledger.js.
// ---------------------------------------------------------------------------
function modelRun(ops) {
  const accounts = {};
  const appliedEventIds = [];
  for (const op of ops) {
    if (appliedEventIds.includes(op.eventId)) {
      continue;
    }
    const account = accounts[op.account] ?? {
      limit: LIMIT,
      available: LIMIT,
      held: 0,
      frozen: false,
    };
    if (op.type === 'reserve') {
      if (account.frozen || account.available < op.amount) {
        continue; // rejected, no event
      }
      account.available -= op.amount;
      account.held += op.amount;
    } else if (op.type === 'commit') {
      if (account.held < op.amount) {
        continue;
      }
      account.held -= op.amount;
      account.limit -= op.amount;
    } else if (op.type === 'release') {
      if (account.held < op.amount) {
        continue;
      }
      account.held -= op.amount;
      account.available += op.amount;
    } else if (op.type === 'freeze') {
      account.frozen = true;
    }
    accounts[op.account] = account; // only accepted ops create the account
    appliedEventIds.push(op.eventId);
  }
  return { accounts, appliedEventIds };
}

// ---------------------------------------------------------------------------
// Real ledger run with a single injected crash. After the crash the ledger is
// restarted (fresh Ledger.open on the same file), the crashed operation is
// retried once (idempotency probe), and the remaining ops are applied.
// ---------------------------------------------------------------------------
function realRun(file, ops, crash) {
  let ledger = Ledger.open(file, { defaultLimit: LIMIT, crash });

  const applyOp = (op) => {
    try {
      if (op.type === 'freeze') {
        ledger.freeze(op.account, op.eventId);
      } else {
        ledger[op.type](op.account, op.amount, op.eventId);
      }
    } catch (error) {
      if (error instanceof LedgerError) {
        return; // business rejection: no event appended
      }
      throw error;
    }
  };

  let crashedAt = -1;
  for (let index = 0; index < ops.length; index += 1) {
    try {
      applyOp(ops[index]);
    } catch (error) {
      if (error instanceof CrashError) {
        crashedAt = index;
        break;
      }
      throw error;
    }
  }

  if (crashedAt >= 0) {
    ledger = Ledger.open(file, { defaultLimit: LIMIT }); // restart
    assert.equal(ledger.recovery.truncated, false, 'clean log must never be truncated');
    applyOp(ops[crashedAt]); // retry: duplicate after afterAppend, fresh after beforeAppend
    for (let index = crashedAt + 1; index < ops.length; index += 1) {
      applyOp(ops[index]);
    }
  }

  // Final reopen proves durability of everything that was applied.
  return Ledger.open(file, { defaultLimit: LIMIT });
}

function assertValidChain(events) {
  let previous = GENESIS_HASH;
  events.forEach((event, index) => {
    assert.equal(event.seq, index);
    assert.equal(event.prevHash, previous);
    assert.equal(event.hash, hashEvent(event));
    previous = event.hash;
  });
  return previous;
}

// ---------------------------------------------------------------------------
// Operation space and sequence generation (deterministic, seeded).
// ---------------------------------------------------------------------------
const OP_SPACE = [
  { type: 'reserve', account: 'a', amount: 10 },
  { type: 'reserve', account: 'a', amount: 60 },
  { type: 'reserve', account: 'b', amount: 25 },
  { type: 'commit', account: 'a', amount: 10 },
  { type: 'commit', account: 'a', amount: 70 },
  { type: 'release', account: 'a', amount: 5 },
  { type: 'release', account: 'b', amount: 30 },
  { type: 'freeze', account: 'a' },
  { type: 'freeze', account: 'b' },
];

function mulberry32(seed) {
  let state = seed;
  return () => {
    state |= 0;
    state = (state + 0x6d2b79f5) | 0;
    let value = Math.imul(state ^ (state >>> 15), 1 | state);
    value = (value + Math.imul(value ^ (value >>> 7), 61 | value)) ^ value;
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
  };
}

function withEventIds(ops) {
  return ops.map((op, index) => ({ ...op, eventId: `ev${index}` }));
}

function generateSequences() {
  const sequences = [];
  const pick = (...indices) => indices.map((index) => OP_SPACE[index]);
  // Hand-picked edge cases.
  sequences.push(pick(0));
  sequences.push(pick(0, 3));
  sequences.push(pick(0, 7, 1)); // reserve, freeze, reserve (rejected)
  sequences.push(pick(1, 4)); // over-commit (rejected)
  sequences.push(pick(2, 6)); // over-release (rejected)
  sequences.push(pick(0, 1, 3, 5, 7)); // full happy path then freeze
  sequences.push(pick(7, 0, 2, 8, 3)); // freeze first
  sequences.push(pick(0, 0, 3, 3, 5)); // duplicate op shapes, unique eventIds
  // Seeded random sequences, length 1..5.
  const random = mulberry32(20261003);
  for (let count = 0; count < 48; count += 1) {
    const length = 1 + Math.floor(random() * 5);
    const sequence = [];
    for (let index = 0; index < length; index += 1) {
      sequence.push(OP_SPACE[Math.floor(random() * OP_SPACE.length)]);
    }
    sequences.push(sequence);
  }
  return sequences.map(withEventIds);
}

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ledger-model-'));

test('reference model: every sequence (<=5 events) x every fault point matches', () => {
  const sequences = generateSequences();
  let runCount = 0;

  sequences.forEach((ops, sequenceIndex) => {
    const expected = modelRun(ops);
    const validOpCount = expected.appliedEventIds.length;

    // Fault points: no crash, plus beforeAppend/afterAppend at each append.
    const faultPoints = [null];
    for (let at = 0; at < validOpCount; at += 1) {
      faultPoints.push({ phase: 'beforeAppend', at });
      faultPoints.push({ phase: 'afterAppend', at });
    }

    for (const crash of faultPoints) {
      const file = path.join(tmpRoot, `seq${sequenceIndex}-${runCount}.jsonl`);
      runCount += 1;
      const final = realRun(file, ops, crash);
      const label = `seq#${sequenceIndex} crash=${JSON.stringify(crash)}`;

      assert.deepEqual(final.state(), expected.accounts, `state mismatch: ${label}`);
      assert.deepEqual(
        final.events.map((event) => event.eventId),
        expected.appliedEventIds,
        `applied event mismatch: ${label}`,
      );
      const chainTip = assertValidChain(final.events);
      assert.equal(final.lastHash, chainTip, `chain tip mismatch: ${label}`);
      assert.equal(final.recovery.truncated, false, `unexpected truncation: ${label}`);
    }
  });

  assert.ok(runCount > 200, `expected broad coverage, ran ${runCount} fault scenarios`);
  console.log(`model comparison: ${sequences.length} sequences, ${runCount} fault scenarios, all matched`);
});
