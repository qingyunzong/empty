'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { run, EXIT_OK, EXIT_BUDGET, EXIT_MONOTONIC } = require('../lib/engine');

const M = (seq, tool, wear, extra = {}) => ({ t: seq, type: 'MEASURE', tool, wear, seq, ...extra });
const CH = (seq, tool, next) => ({ t: seq, type: 'CHANGE', tool, new: next, seq });
const RS = (seq, tool, admin = 'tester') => ({ t: seq, type: 'RESET', tool, admin, seq });

// Acceptance 1: retransmission + out-of-order must not accumulate twice.
test('retransmit and out-of-order MEASURE are applied at most once, evidence kept', () => {
  const ops = [
    M(1, 'T1', 10),
    M(3, 'T1', 30),
    M(2, 'T1', 20), // out-of-order old: seq 2 < confirmed 3 -> ignored
    M(3, 'T1', 30), // retransmission -> ignored
    M(4, 'T1', 40),
    M(4, 'T1', 40), // retransmission -> ignored
  ];
  const r = run(ops, { limit: 80, max: 3 });
  assert.equal(r.exitCode, EXIT_OK);
  assert.equal(r.wear, 40); // not 10+30+20+30+40+40; set-once semantics
  assert.equal(r.curve.length, 3); // seq 1, 3, 4 applied
  const kinds = r.evidence.map((e) => e.kind);
  assert.deepEqual(kinds, ['OUT_OF_ORDER', 'DUPLICATE', 'DUPLICATE']);
  assert.equal(r.rejections.length, 0);
});

test('retransmitted CHANGE does not consume budget twice', () => {
  const ops = [M(1, 'T1', 90), CH(2, 'T1', 'T2'), CH(2, 'T1', 'T2'), M(3, 'T2', 5)];
  const r = run(ops, { limit: 80, max: 3 });
  assert.equal(r.budgetUsed, 1);
  assert.equal(r.activeTool, 'T2');
  assert.equal(r.evidence.filter((e) => e.kind === 'DUPLICATE').length, 1);
});

// Acceptance 2: RESET rejected while a CHANGE is unacknowledged.
test('RESET rejected while CHANGE pending, accepted after ack when worn', () => {
  const ops = [
    M(1, 'T1', 90),
    CH(2, 'T1', 'T2'),
    RS(3, 'T2'), // pending CHANGE -> reject
    M(4, 'T2', 85), // acks the CHANGE, wear >= limit
    RS(5, 'T2'), // now allowed
  ];
  const r = run(ops, { limit: 80, max: 3 });
  assert.equal(r.exitCode, EXIT_OK);
  assert.equal(r.rejections.length, 1);
  assert.equal(r.rejections[0].reason, 'PENDING_CHANGE');
  assert.equal(r.rejections[0].seq, 3);
  assert.equal(r.budgetUsed, 2); // CHANGE + RESET
  assert.equal(r.wear, 0);
  assert.equal(r.pendingChange, null);
});

// Acceptance 3: exact limit boundary.
test('RESET at exactly limit succeeds, at limit-1 rejected', () => {
  const atLimit = run([M(1, 'T1', 80), RS(2, 'T1')], { limit: 80, max: 3 });
  assert.equal(atLimit.exitCode, EXIT_OK);
  assert.equal(atLimit.budgetUsed, 1);
  assert.equal(atLimit.wear, 0);
  assert.equal(atLimit.alarms.length, 1); // alarm fires at exactly limit
  assert.equal(atLimit.alarms[0].wear, 80);

  const below = run([M(1, 'T1', 79), RS(2, 'T1')], { limit: 80, max: 3 });
  assert.equal(below.exitCode, EXIT_OK);
  assert.equal(below.rejections.length, 1);
  assert.equal(below.rejections[0].reason, 'BELOW_LIMIT');
  assert.equal(below.budgetUsed, 0); // rejected: no budget consumed
  assert.equal(below.wear, 79);
  assert.equal(below.alarms.length, 0);
});

test('monotonic violation aborts with exit 11', () => {
  const r = run([M(1, 'T1', 50), M(2, 'T1', 40), M(3, 'T1', 60)], { limit: 80, max: 3 });
  assert.equal(r.exitCode, EXIT_MONOTONIC);
  assert.equal(r.violation.seq, 2);
  assert.equal(r.violation.previous, 50);
  assert.equal(r.violation.reported, 40);
  assert.equal(r.wear, 50); // state frozen at violation point
  assert.equal(r.curve.length, 1); // nothing applied after the violation
});

test('budget exhaustion rejects atomically with exit 5, no half commit', () => {
  const ops = [
    M(1, 'T1', 90),
    CH(2, 'T1', 'T2'), // budget 1/1
    M(3, 'T2', 95),
    RS(4, 'T2'), // budget exhausted -> rejected, wear must stay 95
  ];
  const r = run(ops, { limit: 80, max: 1 });
  assert.equal(r.exitCode, EXIT_BUDGET);
  assert.equal(r.rejections.length, 1);
  assert.equal(r.rejections[0].reason, 'BUDGET_EXCEEDED');
  assert.equal(r.budgetUsed, 1);
  assert.equal(r.wear, 95); // no half commit
  assert.equal(r.activeTool, 'T2');
});

test('expired MEASURE ignored by virtual clock window, evidence kept', () => {
  const ops = [
    M(1, 'T1', 10, { sent: 0 }),
    { t: 100, type: 'MEASURE', tool: 'T1', wear: 20, seq: 2, sent: 10 }, // stale: 100-10 > 30
    M(3, 'T1', 30, { sent: 100 }),
  ];
  const r = run(ops, { limit: 80, max: 3, window: 30 });
  assert.equal(r.wear, 30);
  assert.equal(r.evidence.some((e) => e.kind === 'EXPIRED' && e.seq === 2), true);
});

// Acceptance 4: cross-check against a brute-force replay oracle on small sequences.
function lcg(seed) {
  let s = seed >>> 0;
  return () => ((s = (Math.imul(s, 1664525) + 1013904223) >>> 0) / 2 ** 32);
}

// Deliberately naive, O(n^2) independent re-implementation of the spec.
function bruteForce(ops, { limit, max, window = Infinity }) {
  const wear = new Map();
  const seen = [];
  let active = null;
  let pending = null;
  let budget = 0;
  let now = 0;
  let violated = false;
  let budgetHit = false;
  let rejected = 0;
  for (const op of ops) {
    if (typeof op.t === 'number') now = Math.max(now, op.t);
    if (seen.some((s) => s === op.seq)) continue; // retransmission
    const maxSeen = seen.length ? Math.max(...seen) : -Infinity;
    if (op.seq < maxSeen) continue; // out-of-order old
    if (op.type === 'MEASURE') {
      const sent = typeof op.sent === 'number' ? op.sent : (typeof op.t === 'number' ? op.t : now);
      if (now - sent > window) { seen.push(op.seq); continue; }
      const w = wear.has(op.tool) ? wear.get(op.tool) : 0;
      if (op.wear < w) { violated = true; break; }
      wear.set(op.tool, op.wear);
      seen.push(op.seq);
      if (active === null) active = op.tool;
      if (pending && pending.tool === op.tool) pending = null;
    } else if (op.type === 'CHANGE') {
      if (budget >= max) { budgetHit = true; rejected += 1; continue; }
      budget += 1;
      wear.set(op.tool, 0);
      active = op.new;
      wear.set(op.new, 0);
      pending = { tool: op.new };
      seen.push(op.seq);
    } else if (op.type === 'RESET') {
      const w = wear.has(op.tool) ? wear.get(op.tool) : 0;
      if (pending || op.tool !== active || w < limit) { rejected += 1; continue; }
      if (budget >= max) { budgetHit = true; rejected += 1; continue; }
      budget += 1;
      wear.set(op.tool, 0);
      seen.push(op.seq);
    }
  }
  return {
    exitCode: violated ? EXIT_MONOTONIC : budgetHit ? EXIT_BUDGET : EXIT_OK,
    activeTool: active,
    budgetUsed: budget,
    pendingTool: pending ? pending.tool : null,
    tools: Object.fromEntries([...wear].map(([k, v]) => [k, v])),
    rejections: rejected,
  };
}

function randomOps(rand, n) {
  const tools = ['T1', 'T2', 'T3'];
  const fresh = ['N1', 'N2', 'N3'];
  const ops = [];
  for (let i = 0; i < n; i += 1) {
    const seq = 1 + Math.floor(rand() * (n * 2)); // colliding seqs -> duplicates/reorder
    const kind = rand();
    const t = i; // virtual clock: arrival order
    if (kind < 0.55) {
      ops.push({ t, type: 'MEASURE', tool: tools[Math.floor(rand() * tools.length)],
        wear: Math.floor(rand() * 100), seq });
    } else if (kind < 0.8) {
      ops.push({ t, type: 'CHANGE', tool: tools[Math.floor(rand() * tools.length)],
        new: fresh[Math.floor(rand() * fresh.length)], seq });
    } else {
      ops.push({ t, type: 'RESET', tool: tools[Math.floor(rand() * tools.length)],
        admin: 'fuzz', seq });
    }
  }
  // random retransmissions
  const out = [];
  for (const op of ops) {
    out.push(op);
    if (rand() < 0.35) out.push({ ...op });
  }
  // shuffle arrival order
  for (let i = out.length - 1; i > 0; i -= 1) {
    const j = Math.floor(rand() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

test('engine matches brute-force replay on 500 random small sequences', () => {
  for (let seed = 1; seed <= 500; seed += 1) {
    const rand = lcg(seed);
    const ops = randomOps(rand, 4 + Math.floor(rand() * 8));
    const opts = { limit: 80, max: 3 };
    const expected = bruteForce(ops, opts);
    const actual = run(ops, opts);
    assert.equal(actual.exitCode, expected.exitCode, `seed ${seed} exitCode`);
    assert.equal(actual.activeTool, expected.activeTool, `seed ${seed} activeTool`);
    assert.equal(actual.budgetUsed, expected.budgetUsed, `seed ${seed} budgetUsed`);
    assert.equal(actual.pendingChange ? actual.pendingChange.tool : null, expected.pendingTool, `seed ${seed} pending`);
    assert.deepEqual(actual.tools, expected.tools, `seed ${seed} tools`);
    assert.equal(actual.rejections.length, expected.rejections, `seed ${seed} rejections`);
  }
});
