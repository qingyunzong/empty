import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { validateHistory } from '../src/validate.js';
import { checkLinearizable } from '../src/checker.js';
import { enumerateLinearizations } from '../src/enumerator.js';

// Cross-checks the backtracking checker against the independent brute-force
// permutation enumerator on histories of <= 6 operations.

function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// Builds a guaranteed-linearizable history by executing a random sequential
// run, then assigns random (possibly overlapping) invocation/response times
// consistent with that run order.
function randomConsistentHistory(rand, n) {
  const initial = { a: 100, b: 50 };
  const balance = { a: 100, b: 50 };
  const frozen = { a: 0, b: 0 };
  const reservations = new Map();
  const accounts = ['a', 'b'];
  const ops = [];
  let clock = 0;

  for (let i = 0; i < n; i++) {
    const account = accounts[Math.floor(rand() * accounts.length)];
    const open = [...reservations.entries()].filter(([, r]) => r.status === 'open');
    const kind = ['reserve', 'commit', 'cancel', 'read'][Math.floor(rand() * 4)];
    const op = {
      client: `c${i % 3}`,
      opId: `op${i}`,
      account,
      ok: true,
    };
    if (kind === 'reserve') {
      op.type = 'reserve';
      op.amount = Math.floor(rand() * 60);
      op.reserveId = `r${i}`;
      op.ok = balance[account] >= op.amount;
      if (op.ok) {
        balance[account] -= op.amount;
        frozen[account] += op.amount;
        reservations.set(op.reserveId, { account, amount: op.amount, status: 'open' });
      }
    } else if (kind === 'commit' || kind === 'cancel') {
      op.type = kind;
      if (open.length === 0 || rand() < 0.2) {
        op.reserveId = 'unknown';
        op.ok = false;
      } else {
        const [id, r] = open[Math.floor(rand() * open.length)];
        op.reserveId = id;
        if (kind === 'commit') {
          frozen[r.account] -= r.amount;
          r.status = 'committed';
        } else {
          frozen[r.account] -= r.amount;
          balance[r.account] += r.amount;
          r.status = 'cancelled';
        }
      }
    } else {
      op.type = 'read';
      op.result = { balance: balance[account], frozen: frozen[account] };
    }

    // random interval; sequential run order stays a valid linearization
    const invocationTime = clock + Math.floor(rand() * 3);
    const responseTime = invocationTime + 1 + Math.floor(rand() * 4);
    op.invocationTime = invocationTime;
    op.responseTime = responseTime;
    clock = invocationTime + 1; // allow overlap with the next op
    ops.push(op);
  }
  return { ops, initial };
}

// Randomly corrupts a history (flip ok, tweak read results) to produce
// histories that may or may not be linearizable.
function corrupt(rand, ops) {
  const copy = ops.map((o) => ({ ...o, result: o.result ? { ...o.result } : null }));
  const victim = copy[Math.floor(rand() * copy.length)];
  if (victim.type === 'read') {
    victim.result.balance += 1 + Math.floor(rand() * 10);
  } else {
    victim.ok = !victim.ok;
  }
  return copy;
}

function assertAgreement(ops, initial, label) {
  const checked = checkLinearizable(ops, { initial });
  const enumerated = enumerateLinearizations(ops, { initial });
  assert.equal(
    checked.linearizable,
    enumerated.linearizable,
    `${label}: checker=${checked.linearizable} enumerator=${enumerated.linearizable}`
  );
}

test('checker and enumerator agree on all fixtures (<= 6 ops)', async () => {
  const names = [
    'overlapping-read.json',
    'cancel-then-commit.json',
    'zero-amount.json',
    'unknown-reserveid.json',
  ];
  for (const name of names) {
    const ops = validateHistory(
      JSON.parse(await readFile(new URL(`./fixtures/${name}`, import.meta.url), 'utf8'))
    );
    assertAgreement(ops, { alice: 1000 }, name);
  }
});

test('checker and enumerator agree on 300 random histories of 1-6 ops', () => {
  const rand = mulberry32(20261003);
  for (let trial = 0; trial < 300; trial++) {
    const n = 1 + Math.floor(rand() * 6);
    const { ops, initial } = randomConsistentHistory(rand, n);
    const candidate = rand() < 0.5 ? corrupt(rand, ops) : ops;
    const validated = validateHistory(JSON.parse(JSON.stringify(candidate)));
    assertAgreement(validated, initial, `trial ${trial} (n=${n})`);
  }
});

test('checker and enumerator agree on exhaustive small space', () => {
  // All combinations of 2 ops over a tiny alphabet, both ok values.
  const initial = { a: 10 };
  const templates = [
    { type: 'reserve', account: 'a', amount: 5, reserveId: 'r1' },
    { type: 'commit', account: 'a', reserveId: 'r1' },
    { type: 'cancel', account: 'a', reserveId: 'r1' },
    { type: 'read', account: 'a', result: { balance: 10, frozen: 0 } },
    { type: 'read', account: 'a', result: { balance: 5, frozen: 5 } },
  ];
  let count = 0;
  for (const t1 of templates) {
    for (const t2 of templates) {
      for (const ok1 of [true, false]) {
        for (const ok2 of [true, false]) {
          const ops = validateHistory([
            { client: 'x', opId: 'p', invocationTime: 0, responseTime: 10, ok: ok1, ...t1 },
            { client: 'y', opId: 'q', invocationTime: 1, responseTime: 11, ok: ok2, ...t2 },
          ]);
          assertAgreement(ops, initial, `${t1.type}/${t2.type} ok=${ok1},${ok2}`);
          count++;
        }
      }
    }
  }
  assert.equal(count, 100);
});
