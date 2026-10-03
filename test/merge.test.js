'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  RULES,
  canonical,
  sha256Hex,
  mergeMaps,
  mergeTexts,
  parseJsonl,
  MergeInputError,
} = require('../lib/merge');

function rec(id, overrides = {}) {
  return {
    id,
    account: `acct-${id}`,
    amount: 100 + id,
    ccy: 'USD',
    seq: id,
    status: 'DRAFT',
    ...overrides,
  };
}

function toMap(records) {
  return new Map(records.map((r) => [r.id, r]));
}

test('clean three-way merge with deterministic id ordering', () => {
  const base = [rec(3), rec(1), rec(2), rec(4)];
  const left = [rec(1, { amount: 500 }), rec(2), rec(3, { status: 'LOCKED' }), rec(4)];
  const right = [rec(1), rec(2, { ccy: 'EUR' }), rec(3), rec(4, { seq: 40 })];
  const { records, conflicts } = mergeMaps(toMap(base), toMap(left), toMap(right));
  assert.deepEqual(conflicts, []);
  assert.deepEqual(records.map((r) => r.id), [1, 2, 3, 4]);
  assert.equal(records[0].amount, 500);
  assert.equal(records[1].ccy, 'EUR');
  assert.equal(records[2].status, 'LOCKED');
  assert.equal(records[3].seq, 40);
});

test('identical change on both sides merges cleanly', () => {
  const base = [rec(1)];
  const left = [rec(1, { amount: 900 })];
  const right = [rec(1, { amount: 900 })];
  const { records, conflicts } = mergeMaps(toMap(base), toMap(left), toMap(right));
  assert.deepEqual(conflicts, []);
  assert.equal(records[0].amount, 900);
});

test('amount changed on both sides differently conflicts and is excluded from result', () => {
  const base = [rec(1), rec(2)];
  const left = [rec(1, { amount: 700 }), rec(2)];
  const right = [rec(1, { amount: 800 }), rec(2)];
  const { records, conflicts } = mergeMaps(toMap(base), toMap(left), toMap(right));
  assert.deepEqual(records.map((r) => r.id), [2]);
  assert.equal(conflicts.length, 1);
  const c = conflicts[0];
  assert.equal(c.id, 1);
  assert.equal(c.rule, RULES.AMOUNT_BOTH_CHANGED);
  assert.equal(c.base.amount, 101);
  assert.equal(c.left.amount, 700);
  assert.equal(c.right.amount, 800);
  const { sha256, ...rest } = c;
  assert.equal(sha256, sha256Hex(canonical(rest)));
});

test('status rollback is a conflict', () => {
  const base = [rec(1, { status: 'LOCKED' })];
  const left = [rec(1, { status: 'DRAFT' })];
  const right = [rec(1, { status: 'LOCKED' })];
  const { records, conflicts } = mergeMaps(toMap(base), toMap(left), toMap(right));
  assert.deepEqual(records, []);
  assert.equal(conflicts[0].rule, RULES.STATUS_ROLLBACK);
});

test('forward status transitions merge; both-forward divergence conflicts', () => {
  const base = [rec(1, { status: 'DRAFT' }), rec(2, { status: 'DRAFT' })];
  const left = [rec(1, { status: 'SETTLED' }), rec(2, { status: 'LOCKED' })];
  const right = [rec(1, { status: 'DRAFT' }), rec(2, { status: 'SETTLED' })];
  const { records, conflicts } = mergeMaps(toMap(base), toMap(left), toMap(right));
  assert.equal(records[0].status, 'SETTLED');
  assert.equal(conflicts.length, 1);
  assert.equal(conflicts[0].id, 2);
  assert.equal(conflicts[0].rule, RULES.STATUS_BOTH_CHANGED);
});

test('delete vs modify conflicts; delete vs untouched deletes', () => {
  const base = [rec(1), rec(2), rec(3)];
  const left = [rec(2)];
  const right = [rec(1), rec(2), rec(3, { amount: 999 })];
  const { records, conflicts } = mergeMaps(toMap(base), toMap(left), toMap(right));
  assert.deepEqual(records.map((r) => r.id), [2]);
  assert.equal(conflicts.length, 1);
  assert.equal(conflicts[0].id, 3);
  assert.equal(conflicts[0].rule, RULES.DELETE_VS_MODIFY);
  assert.equal(conflicts[0].left, null);
  assert.equal(conflicts[0].right.amount, 999);
});

test('both sides delete removes the record', () => {
  const { records, conflicts } = mergeMaps(toMap([rec(1)]), toMap([]), toMap([]));
  assert.deepEqual(records, []);
  assert.deepEqual(conflicts, []);
});

test('add-add with different payloads conflicts; identical adds merge', () => {
  const a = mergeMaps(toMap([]), toMap([rec(1, { amount: 1 })]), toMap([rec(1, { amount: 2 })]));
  assert.equal(a.conflicts[0].rule, RULES.ADD_ADD_CONFLICT);
  const b = mergeMaps(toMap([]), toMap([rec(5)]), toMap([rec(5)]));
  assert.deepEqual(b.conflicts, []);
  assert.equal(b.records[0].id, 5);
});

test('parseJsonl rejects bad lines, duplicate ids and illegal status', () => {
  assert.throws(
    () => parseJsonl('{"id":1}\nnot-json\n', 'base.jsonl'),
    (err) => err instanceof MergeInputError && err.code === 'BAD_JSONL' && err.line === 2,
  );
  assert.throws(
    () => parseJsonl('{"id":1}\n{"id":1}\n', 'left.jsonl'),
    (err) => err.code === 'DUP_ID' && err.line === 2,
  );
  assert.throws(
    () => parseJsonl('{"id":1,"status":"ARCHIVED"}\n', 'right.jsonl'),
    (err) => err.code === 'INVALID_STATUS' && err.line === 1,
  );
});

test('mergeTexts integrates parsing and merging', () => {
  const { records, conflicts } = mergeTexts(
    '{"id":1,"amount":10,"status":"DRAFT"}\n',
    '{"id":1,"amount":10,"status":"LOCKED"}\n',
    '{"id":1,"amount":10,"status":"DRAFT"}\n',
  );
  assert.deepEqual(conflicts, []);
  assert.equal(records[0].status, 'LOCKED');
});

// ---- brute-force cross-check: enumerate all single-field mutations ----

const STATUSES = ['DRAFT', 'LOCKED', 'SETTLED'];
const CCYS = ['USD', 'EUR', 'JPY'];

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

// Independent oracle implementing the spec directly.
function oracleMerge(baseMap, leftMap, rightMap) {
  const rank = { DRAFT: 0, LOCKED: 1, SETTLED: 2 };
  const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b);
  const ids = [...new Set([...baseMap.keys(), ...leftMap.keys(), ...rightMap.keys()])].sort(
    (x, y) => (x < y ? -1 : x > y ? 1 : 0),
  );
  const records = [];
  const conflictRules = [];
  for (const id of ids) {
    const b = baseMap.get(id) ?? null;
    const l = leftMap.get(id) ?? null;
    const r = rightMap.get(id) ?? null;
    if (b === null) {
      if (l === null) { if (r !== null) records.push(r); continue; }
      if (r === null) { records.push(l); continue; }
      if (eq(l, r)) records.push(l); else conflictRules.push([id, RULES.ADD_ADD_CONFLICT]);
      continue;
    }
    if (l === null && r === null) continue;
    if (l === null) {
      if (!eq(r, b)) conflictRules.push([id, RULES.DELETE_VS_MODIFY]);
      continue;
    }
    if (r === null) {
      if (!eq(l, b)) conflictRules.push([id, RULES.DELETE_VS_MODIFY]);
      continue;
    }
    if (rank[l.status] < rank[b.status] || rank[r.status] < rank[b.status]) {
      conflictRules.push([id, RULES.STATUS_ROLLBACK]);
      continue;
    }
    const out = { id };
    let bad = null;
    for (const f of ['account', 'amount', 'ccy', 'seq', 'status']) {
      if (Object.is(l[f], r[f])) { out[f] = l[f]; continue; }
      if (Object.is(l[f], b[f])) { out[f] = r[f]; continue; }
      if (Object.is(r[f], b[f])) { out[f] = l[f]; continue; }
      bad = f;
      break;
    }
    if (bad) {
      const rule = { amount: RULES.AMOUNT_BOTH_CHANGED, ccy: RULES.CCY_BOTH_CHANGED, status: RULES.STATUS_BOTH_CHANGED }[bad] ?? RULES.FIELD_BOTH_CHANGED;
      conflictRules.push([id, rule]);
    } else {
      records.push(out);
    }
  }
  return { records, conflictRules };
}

function mutate(records, rand, mutations) {
  const out = records.map((r) => ({ ...r }));
  for (let m = 0; m < mutations; m += 1) {
    const action = rand();
    if (action < 0.15 && out.length > 0) {
      out.splice(Math.floor(rand() * out.length), 1);
    } else if (action < 0.25) {
      const id = 1000 + m;
      out.push(rec(id, { amount: Math.floor(rand() * 500), status: STATUSES[Math.floor(rand() * 3)] }));
    } else if (out.length > 0) {
      const target = out[Math.floor(rand() * out.length)];
      const field = ['account', 'amount', 'ccy', 'seq', 'status'][Math.floor(rand() * 5)];
      if (field === 'amount') target.amount = Math.floor(rand() * 1000);
      else if (field === 'ccy') target.ccy = CCYS[Math.floor(rand() * CCYS.length)];
      else if (field === 'status') target.status = STATUSES[Math.floor(rand() * STATUSES.length)];
      else if (field === 'seq') target.seq = Math.floor(rand() * 100);
      else target.account = `acct-x${Math.floor(rand() * 10)}`;
    }
  }
  return out;
}

test('brute force: random small sets (n<=8) match oracle over all single-field mutations', () => {
  let cases = 0;
  for (let seed = 1; seed <= 40; seed += 1) {
    const rand = mulberry32(seed);
    const n = 1 + Math.floor(rand() * 8);
    const base = Array.from({ length: n }, (_, i) =>
      rec(i + 1, {
        amount: Math.floor(rand() * 1000),
        ccy: CCYS[Math.floor(rand() * CCYS.length)],
        seq: i + 1,
        status: STATUSES[Math.floor(rand() * STATUSES.length)],
      }));
    for (let round = 0; round < 25; round += 1) {
      const left = mutate(base, rand, 1 + Math.floor(rand() * 3));
      const right = mutate(base, rand, 1 + Math.floor(rand() * 3));
      const expected = oracleMerge(toMap(base), toMap(left), toMap(right));
      const actual = mergeMaps(toMap(base), toMap(left), toMap(right));
      assert.deepEqual(
        actual.records,
        expected.records,
        `records mismatch seed=${seed} round=${round}`,
      );
      assert.deepEqual(
        actual.conflicts.map((c) => [c.id, c.rule]),
        expected.conflictRules,
        `conflicts mismatch seed=${seed} round=${round}`,
      );
      for (const c of actual.conflicts) {
        const { sha256, ...rest } = c;
        assert.equal(sha256, sha256Hex(canonical(rest)));
      }
      cases += 1;
    }
  }
  assert.ok(cases >= 1000, `expected >=1000 brute-force cases, got ${cases}`);
});

test('merge is deterministic across runs', () => {
  const rand = mulberry32(99);
  const base = Array.from({ length: 8 }, (_, i) => rec(i + 1, { amount: i * 7 }));
  const left = mutate(base, rand, 4);
  const right = mutate(base, rand, 4);
  const first = mergeMaps(toMap(base), toMap(left), toMap(right));
  const second = mergeMaps(toMap(base), toMap(left), toMap(right));
  assert.deepEqual(first, second);
});
