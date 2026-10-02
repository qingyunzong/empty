'use strict';

// Deterministic generators for the reference-replay cross-check.

function mulberry32(seed) {
  let a = seed >>> 0;
  return function next() {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function randInt(rand, lo, hi) {
  return lo + Math.floor(rand() * (hi - lo + 1));
}

const ACCOUNTS = ['alice', 'bob', 'carol'];
const CURRENCIES = ['USD', 'EUR'];
const STATES = ['PENDING', 'SETTLED', 'CANCELLED'];
const MAX_AMOUNT = 3;

function genInstructions(rand, n) {
  const out = [];
  for (let i = 0; i < n; i += 1) {
    out.push({
      id: `i${i}`,
      account: ACCOUNTS[randInt(rand, 0, ACCOUNTS.length - 1)],
      debit: randInt(rand, 0, MAX_AMOUNT),
      credit: randInt(rand, 0, MAX_AMOUNT),
      freeze: randInt(rand, 0, MAX_AMOUNT),
      state: STATES[randInt(rand, 0, STATES.length - 1)],
      currency: CURRENCIES[randInt(rand, 0, CURRENCIES.length - 1)],
      memo: '',
    });
  }
  return out;
}

function freshId(table, base) {
  const ids = new Set(table.map((i) => i.id));
  let candidate = base;
  let counter = 0;
  while (ids.has(candidate)) {
    counter += 1;
    candidate = `${base}#${counter}`;
  }
  return candidate;
}

function splitOps(table) {
  const ops = [];
  for (const instr of table) {
    for (let d1 = 0; d1 <= instr.debit; d1 += 1) {
      for (let c1 = 0; c1 <= instr.credit; c1 += 1) {
        for (let f1 = 0; f1 <= instr.freeze; f1 += 1) {
          const idA = freshId(table, `${instr.id}a`);
          const idB = freshId(table, `${instr.id}b`);
          ops.push({
            op: 'split',
            id: instr.id,
            parts: [
              { id: idA, debit: d1, credit: c1, freeze: f1 },
              { id: idB, debit: instr.debit - d1, credit: instr.credit - c1, freeze: instr.freeze - f1 },
            ],
          });
        }
      }
    }
  }
  return ops;
}

function* subsets(pool, start, k, acc) {
  if (k === 0) {
    yield acc;
    return;
  }
  for (let i = start; i <= pool.length - k; i += 1) {
    yield* subsets(pool, i + 1, k - 1, [...acc, pool[i]]);
  }
}

function mergeOps(table) {
  const ops = [];
  const groups = new Map();
  for (const instr of table) {
    const key = `${instr.account}${instr.currency}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(instr);
  }
  for (const members of groups.values()) {
    for (let size = 2; size <= members.length; size += 1) {
      for (const combo of subsets(members, 0, size, [])) {
        const ids = combo.map((m) => m.id);
        ops.push({ op: 'merge', ids, newId: freshId(table, `m_${ids.join('_')}`) });
      }
    }
  }
  return ops;
}

function restateOps(table) {
  const ops = [];
  for (const instr of table) {
    if (instr.state === 'SETTLED') {
      ops.push({ op: 'restate', id: instr.id, fields: { memo: `note-${instr.id}` } });
      continue;
    }
    for (const field of ['debit', 'credit', 'freeze']) {
      for (let value = 0; value <= MAX_AMOUNT; value += 1) {
        if (value !== instr[field]) {
          ops.push({ op: 'restate', id: instr.id, fields: { [field]: value } });
        }
      }
    }
    for (const state of STATES) {
      if (state !== instr.state) {
        ops.push({ op: 'restate', id: instr.id, fields: { state } });
      }
    }
    ops.push({ op: 'restate', id: instr.id, fields: { memo: `note-${instr.id}` } });
  }
  return ops;
}

function allLegalOps(table) {
  return [...splitOps(table), ...mergeOps(table), ...restateOps(table)];
}

module.exports = { mulberry32, randInt, genInstructions, allLegalOps, MAX_AMOUNT };
