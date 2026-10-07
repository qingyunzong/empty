import test from 'node:test';
import assert from 'node:assert/strict';
import { Ledger, canonical, DEFAULT_TTL } from '../src/engine.js';

// Independent reference model: a plain sequential reducer over the canonically
// sorted op list. Written separately from the engine on purpose; the engine
// must agree with it for every possible arrival order of the same op set.

function compareOps(a, b) {
  if (a.clock !== b.clock) return a.clock - b.clock;
  if (a.clientOpId !== b.clientOpId) return a.clientOpId < b.clientOpId ? -1 : 1;
  const ca = canonical(a);
  const cb = canonical(b);
  return ca < cb ? -1 : ca > cb ? 1 : 0;
}

function modelView(ops) {
  const sorted = ops.slice().sort(compareOps);
  const winners = new Map();
  for (const op of sorted) {
    if (!winners.has(op.clientOpId)) winners.set(op.clientOpId, op);
  }
  const seen = new Set();
  const holds = new Map();
  let available = 0;
  let frozen = 0;
  let captured = 0;

  const parentMissing = (op) => {
    const parent = winners.get(op.parent);
    return !(parent !== undefined && op.clock <= parent.clock);
  };

  for (const op of sorted) {
    if (seen.has(op.clientOpId)) continue;
    seen.add(op.clientOpId);

    if (op.type === 'deposit') {
      available += op.amount;
      continue;
    }
    if (op.type === 'authorize') {
      if (available < op.amount) continue;
      available -= op.amount;
      frozen += op.amount;
      holds.set(op.clientOpId, {
        id: op.clientOpId,
        status: 'PENDING',
        amount: op.amount,
        remaining: op.amount,
        captured: 0,
        voided: 0,
        createdClock: op.clock,
        timeoutSlot: op.clock + (op.ttl === undefined ? DEFAULT_TTL : op.ttl),
      });
      continue;
    }

    const hold = holds.get(op.parent);
    if (hold === undefined) {
      parentMissing(op);
      continue;
    }
    if (op.clock <= hold.createdClock) continue;

    if (op.type === 'confirm') {
      if (hold.status === 'PENDING') hold.status = 'CONFIRMED';
      continue;
    }
    if (op.type === 'capture') {
      if (hold.status === 'PENDING' || hold.status === 'EXPIRED' || hold.status === 'FAILED') continue;
      if (op.amount > hold.remaining) continue;
      hold.remaining -= op.amount;
      hold.captured += op.amount;
      frozen -= op.amount;
      captured += op.amount;
      if (hold.remaining === 0) hold.status = 'CLOSED';
      continue;
    }
    if (op.type === 'void') {
      if (hold.status === 'VOIDED') continue;
      if (hold.status === 'PENDING' || hold.status === 'EXPIRED' || hold.status === 'FAILED') continue;
      if (hold.remaining === 0) continue;
      const amount = op.amount === undefined ? hold.remaining : op.amount;
      if (amount > hold.remaining) continue;
      hold.remaining -= amount;
      hold.voided += amount;
      frozen -= amount;
      available += amount;
      if (hold.remaining === 0) hold.status = hold.voided === hold.amount ? 'VOIDED' : 'CLOSED';
      continue;
    }
    if (op.type === 'expire') {
      if (hold.status === 'EXPIRED' || hold.status === 'FAILED') continue;
      if (hold.status === 'VOIDED' || hold.status === 'CLOSED') continue;
      if (op.slot < hold.timeoutSlot) continue;
      frozen -= hold.remaining;
      available += hold.remaining;
      hold.remaining = 0;
      hold.status = op.outcome === 'FAILED' ? 'FAILED' : 'EXPIRED';
      continue;
    }
    throw new Error(`model: unexpected op type ${op.type}`);
  }

  return {
    available,
    frozen,
    captured,
    holds: [...holds.values()]
      .map((h) => ({
        id: h.id,
        status: h.status,
        amount: h.amount,
        remaining: h.remaining,
        captured: h.captured,
        voided: h.voided,
        timeoutSlot: h.timeoutSlot,
      }))
      .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)),
  };
}

function mulberry32(seed) {
  let state = seed | 0;
  return () => {
    state = (state + 0x6d2b79f5) | 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function makeOps(n, seed) {
  const rnd = mulberry32(seed);
  const pick = (arr) => arr[Math.floor(rnd() * arr.length)];
  const ops = [];
  const authorizes = [];
  for (let i = 0; i < n; i++) {
    const id = `op${i}`;
    const clock = 1 + Math.floor(rnd() * (n + 2));
    if (i === 0) {
      ops.push({ clientOpId: id, clock, type: 'deposit', amount: 10 + Math.floor(rnd() * 60) });
      continue;
    }
    const kind = pick(['authorize', 'confirm', 'capture', 'void', 'expire', 'deposit', 'authorize', 'void']);
    if (kind === 'deposit') {
      ops.push({ clientOpId: id, clock, type: 'deposit', amount: 5 + Math.floor(rnd() * 30) });
    } else if (kind === 'authorize') {
      const op = { clientOpId: id, clock, type: 'authorize', amount: 5 + Math.floor(rnd() * 25) };
      if (rnd() < 0.7) op.ttl = 1 + Math.floor(rnd() * 3);
      ops.push(op);
      authorizes.push(id);
    } else if (kind === 'confirm') {
      const parent = authorizes.length > 0 && rnd() < 0.9 ? pick(authorizes) : `ghost${i}`;
      ops.push({ clientOpId: id, clock, type: 'confirm', parent });
    } else if (kind === 'capture') {
      const parent = authorizes.length > 0 && rnd() < 0.9 ? pick(authorizes) : `ghost${i}`;
      ops.push({ clientOpId: id, clock, type: 'capture', parent, amount: 1 + Math.floor(rnd() * 20) });
    } else if (kind === 'void') {
      const parent = authorizes.length > 0 && rnd() < 0.9 ? pick(authorizes) : `ghost${i}`;
      const op = { clientOpId: id, clock, type: 'void', parent };
      if (rnd() < 0.8) op.amount = 1 + Math.floor(rnd() * 20);
      ops.push(op);
    } else {
      const parent = authorizes.length > 0 && rnd() < 0.9 ? pick(authorizes) : `ghost${i}`;
      const op = { clientOpId: id, clock, type: 'expire', parent, slot: Math.floor(rnd() * (n + 6)) };
      if (rnd() < 0.3) op.outcome = 'FAILED';
      ops.push(op);
    }
  }
  if (n >= 6) {
    ops[n - 1] = { clientOpId: ops[1].clientOpId, clock: ops[1].clock + 1, type: 'deposit', amount: 7 };
  }
  return ops;
}

function* permutations(items) {
  const a = items.slice();
  const c = new Array(a.length).fill(0);
  yield a.slice();
  let i = 0;
  while (i < a.length) {
    if (c[i] < i) {
      const j = i % 2 === 0 ? 0 : c[i];
      const tmp = a[i];
      a[i] = a[j];
      a[j] = tmp;
      yield a.slice();
      c[i] += 1;
      i = 0;
    } else {
      c[i] = 0;
      i += 1;
    }
  }
}

function factorial(n) {
  let result = 1;
  for (let i = 2; i <= n; i++) result *= i;
  return result;
}

for (let n = 1; n <= 9; n++) {
  test(`n=${n}: every arrival order replays to the independent model's final state`, () => {
    const ops = makeOps(n, 4100 + n);
    const expected = modelView(ops);
    let head = null;
    let count = 0;
    for (const perm of permutations(ops)) {
      const ledger = new Ledger();
      ledger.submitAll(perm);
      assert.deepEqual(ledger.view, expected, `view mismatch for order ${perm.map((o) => o.clientOpId).join(',')}`);
      if (head === null) head = ledger.head;
      else assert.equal(ledger.head, head, 'hash chain head diverged between arrival orders');
      count += 1;
    }
    assert.equal(count, factorial(n));
  });
}
