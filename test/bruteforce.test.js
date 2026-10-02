'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { Engine } = require('../engine');
const { Gateway } = require('../gateway');
const { TYPE } = require('../frame');

const BUDGET = 100;

// Request alphabets: members x amounts, unique reqIds.
const ALPHABET3 = [
  { member: 'ALICE', reqId: 1, want: 40 },
  { member: 'ALICE', reqId: 2, want: 60 },
  { member: 'BOB', reqId: 1, want: 40 },
];
const ALPHABET4 = [
  { member: 'ALICE', reqId: 1, want: 40 },
  { member: 'ALICE', reqId: 2, want: 60 },
  { member: 'BOB', reqId: 1, want: 40 },
  { member: 'BOB', reqId: 2, want: 60 },
];

// Independent brute-force reference: sequential greedy allocation with
// business-level dedup on (member, reqId). Deliberately shares no code with
// the engine.
function referenceAllocate(budget, requests) {
  let left = budget;
  const seen = new Map();
  const grants = [];
  for (const req of requests) {
    const key = `${req.member}#${req.reqId}`;
    if (seen.has(key)) {
      grants.push(seen.get(key));
      continue;
    }
    const g = Math.min(req.want, left);
    left -= g;
    seen.set(key, g);
    grants.push(g);
  }
  return grants;
}

function engineGrants(requests) {
  const engine = new Engine({ budget: BUDGET, ttl: 100000 });
  const gateway = new Gateway({ engine });
  const seqByMember = new Map();
  const grants = [];
  for (const req of requests) {
    const seq = (seqByMember.get(req.member) || 0) + 1;
    seqByMember.set(req.member, seq);
    const replies = gateway.handleFrame({ type: TYPE.RESERVE, ...req, amount: req.want, seq });
    assert.equal(replies.length, 1);
    grants.push(replies[0].got);
    assert.ok(replies[0].budget >= 0);
  }
  return { grants, engine };
}

function* enumerate(alphabet, length, prefix = []) {
  if (prefix.length === length) {
    yield prefix;
    return;
  }
  for (const item of alphabet) yield* enumerate(alphabet, length, [...prefix, item]);
}

test('exhaustive enumeration of <=8-request sequences matches brute-force allocation', () => {
  let checked = 0;
  for (let len = 1; len <= 8; len++) {
    for (const seq of enumerate(ALPHABET3, len)) {
      const { grants, engine } = engineGrants(seq);
      assert.deepEqual(grants, referenceAllocate(BUDGET, seq), `divergence on ${JSON.stringify(seq)}`);
      const total = grants.reduce((a, b, i) => {
        const key = `${seq[i].member}#${seq[i].reqId}`;
        return seq.findIndex((r, j) => j < i && `${r.member}#${r.reqId}` === key) >= 0 ? a : a + b;
      }, 0);
      assert.ok(total <= BUDGET, 'budget exceeded');
      assert.equal(engine.budgetLeft(), BUDGET - total);
      checked += 1;
    }
  }
  assert.ok(checked > 9000, `expected thorough enumeration, got ${checked}`);
});

test('no retroactive re-judgment: every prefix allocation is a prefix of the full run', () => {
  for (let len = 2; len <= 5; len++) {
    for (const seq of enumerate(ALPHABET4, len)) {
      const full = engineGrants(seq).grants;
      for (let k = 1; k < len; k++) {
        const prefix = engineGrants(seq.slice(0, k)).grants;
        assert.deepEqual(prefix, full.slice(0, k));
      }
    }
  }
});

test('determinism: identical streams yield identical Merkle roots', () => {
  for (const seq of enumerate(ALPHABET4, 4)) {
    const a = engineGrants(seq).engine.log.root();
    const b = engineGrants(seq).engine.log.root();
    assert.equal(a, b);
  }
});

test('tie-break: equal amounts at equal tick resolve by member then reqId, deterministically', () => {
  // Same amount (50) at the same virtual tick: canonical priority order is
  // ALICE#1 < ALICE#2 < BOB#1 regardless of any reordering of the requests.
  const candidates = [
    { member: 'BOB', reqId: 1, amount: 50, tick: 0 },
    { member: 'ALICE', reqId: 2, amount: 50, tick: 0 },
    { member: 'ALICE', reqId: 1, amount: 50, tick: 0 },
  ];
  const sorted = candidates.slice().sort(Engine.comparePriority);
  assert.deepEqual(sorted.map((c) => `${c.member}#${c.reqId}`), ['ALICE#1', 'ALICE#2', 'BOB#1']);
  // and allocation under that canonical order is itself brute-force consistent
  const grants = referenceAllocate(120, sorted.map((c) => ({ ...c, want: c.amount })));
  assert.deepEqual(grants, [50, 50, 20]);
});
