'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { Engine, DeptGraph } = require('../lib');

const CONFIG = {
  type: 'config',
  departments: {
    root: [],
    treasury: ['root'],
    trade_finance: ['treasury'],
    tf_ops: ['trade_finance'],
    compliance: ['root'],
  },
  people: {
    alice: 'tf_ops',
    bob: 'tf_ops',
    carol: 'trade_finance',
    dave: 'treasury',
    erin: 'compliance',
  },
};

function run(events) {
  const engine = new Engine(CONFIG);
  const results = events.map((e, i) => engine.apply(e, i + 2));
  return { engine, results, final: engine.finalize() };
}

test('1. dual distinct approvals disburse the request', () => {
  const { final } = run([
    { type: 'submit', request: 'r1', by: 'alice', dept: 'tf_ops', amount: 100, ts: 1 },
    { type: 'approve', request: 'r1', by: 'bob', ts: 2 },
    { type: 'approve', request: 'r1', by: 'carol', ts: 3 },
  ]);
  assert.equal(final.requests.r1.state, 'DISBURSED');
  assert.deepEqual(
    final.transitions.map((t) => [t.from, t.to]),
    [['NONE', 'PENDING'], ['PENDING', 'DISBURSED']],
  );
  assert.equal(final.failures.length, 0);
  assert.match(final.audit_hash, /^[0-9a-f]{64}$/);
});

test('2. duplicate approval by the same person is ineffective', () => {
  const { results, final } = run([
    { type: 'submit', request: 'r1', by: 'alice', dept: 'tf_ops', ts: 1 },
    { type: 'approve', request: 'r1', by: 'bob', ts: 2 },
    { type: 'approve', request: 'r1', by: 'bob', ts: 3 },
  ]);
  assert.equal(results[2].code, 'E_DUPLICATE');
  assert.equal(final.requests.r1.state, 'PENDING');
  assert.equal(final.requests.r1.approvals.length, 1);
  assert.equal(final.failures.length, 1);
  assert.equal(final.failures[0].code, 'E_DUPLICATE');
});

test('2b. submitter cannot approve own request', () => {
  const { results, final } = run([
    { type: 'submit', request: 'r1', by: 'alice', dept: 'tf_ops', ts: 1 },
    { type: 'approve', request: 'r1', by: 'alice', ts: 2 },
  ]);
  assert.equal(results[1].code, 'E_SELF');
  assert.equal(final.requests.r1.state, 'PENDING');
});

test('3. approval recorded during freeze takes effect after unfreeze', () => {
  const { engine, results, final } = run([
    { type: 'submit', request: 'r1', by: 'alice', dept: 'tf_ops', ts: 1 },
    { type: 'approve', request: 'r1', by: 'bob', ts: 2 },
    { type: 'freeze', request: 'r1', by: 'erin', reason: 'screening', ts: 3 },
    { type: 'approve', request: 'r1', by: 'carol', ts: 4 },
    { type: 'unfreeze', request: 'r1', by: 'erin', ts: 5 },
  ]);
  assert.ok(results[3].ok, 'approval during freeze is recorded, not rejected');
  assert.equal(final.requests.r1.state, 'DISBURSED');
  const states = final.transitions.map((t) => t.to);
  assert.deepEqual(states, ['PENDING', 'FROZEN', 'DISBURSED']);
  const disburse = final.transitions.find((t) => t.to === 'DISBURSED');
  assert.equal(disburse.ts, 5, 'disbursement happens at unfreeze time');
  assert.match(disburse.cause, /approve:carol@4/, 'held approval keeps original ts');
  const carol = final.requests.r1.approvals.find((a) => a.by === 'carol');
  assert.equal(carol.ts, 4);
  assert.equal(carol.held, false);
  assert.ok(engine);
});

test('3b. deny during freeze wins over quorum after unfreeze', () => {
  const { final } = run([
    { type: 'submit', request: 'r1', by: 'alice', dept: 'tf_ops', ts: 1 },
    { type: 'approve', request: 'r1', by: 'bob', ts: 2 },
    { type: 'freeze', request: 'r1', by: 'erin', ts: 3 },
    { type: 'approve', request: 'r1', by: 'carol', ts: 4 },
    { type: 'deny', request: 'r1', by: 'dave', reason: 'limit exceeded', ts: 5 },
    { type: 'unfreeze', request: 'r1', by: 'erin', ts: 6 },
  ]);
  assert.equal(final.requests.r1.state, 'DENIED');
});

test('4. revoke after disbursement fails with E_FINAL', () => {
  const { results, final } = run([
    { type: 'submit', request: 'r1', by: 'alice', dept: 'tf_ops', ts: 1 },
    { type: 'approve', request: 'r1', by: 'bob', ts: 2 },
    { type: 'approve', request: 'r1', by: 'carol', ts: 3 },
    { type: 'revoke', request: 'r1', by: 'carol', target: 'carol', ts: 4 },
  ]);
  assert.equal(results[3].code, 'E_FINAL');
  assert.equal(final.requests.r1.state, 'DISBURSED');
  assert.equal(final.requests.r1.approvals.length, 2);
});

test('4b. revoke before disbursement works for self and superior only', () => {
  const { final } = run([
    { type: 'submit', request: 'r1', by: 'alice', dept: 'tf_ops', ts: 1 },
    { type: 'approve', request: 'r1', by: 'bob', ts: 2 },
    { type: 'revoke', request: 'r1', by: 'erin', target: 'bob', ts: 3 },
    { type: 'revoke', request: 'r1', by: 'carol', target: 'bob', ts: 4 },
  ]);
  assert.equal(final.failures.length, 1);
  assert.equal(final.failures[0].code, 'E_REVOKE_AUTH', 'unrelated dept cannot revoke');
  assert.equal(final.requests.r1.approvals.length, 0, 'superior revoke succeeds');
  assert.equal(final.requests.r1.state, 'PENDING');
  const ok = run([
    { type: 'submit', request: 'r2', by: 'alice', dept: 'tf_ops', ts: 1 },
    { type: 'approve', request: 'r2', by: 'bob', ts: 2 },
    { type: 'revoke', request: 'r2', by: 'bob', target: 'bob', ts: 3 },
  ]);
  assert.equal(ok.final.requests.r2.approvals.length, 0, 'self revoke succeeds');
  assert.equal(ok.final.requests.r2.state, 'PENDING');
});

test('5. random dept DAG: ancestors match transitive-closure enumeration', () => {
  function mulberry32(seed) {
    let a = seed >>> 0;
    return () => {
      a |= 0; a = (a + 0x6D2B79F5) | 0;
      let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }
  // Independent reference: Warshall transitive closure over the parent matrix.
  function closureAncestors(depts, parents, dept) {
    const n = depts.length;
    const idx = new Map(depts.map((d, i) => [d, i]));
    const reach = Array.from({ length: n }, () => new Array(n).fill(false));
    for (const [d, ps] of Object.entries(parents)) {
      for (const p of ps) reach[idx.get(d)][idx.get(p)] = true;
    }
    for (let k = 0; k < n; k += 1) {
      for (let i = 0; i < n; i += 1) {
        if (!reach[i][k]) continue;
        for (let j = 0; j < n; j += 1) reach[i][j] = reach[i][j] || reach[k][j];
      }
    }
    const out = new Set();
    const i = idx.get(dept);
    for (let j = 0; j < n; j += 1) if (reach[i][j]) out.add(depts[j]);
    return out;
  }

  for (let seed = 1; seed <= 50; seed += 1) {
    const rand = mulberry32(seed);
    const n = 2 + Math.floor(rand() * 7); // 2..8 departments
    const depts = Array.from({ length: n }, (_, i) => `d${i}`);
    const parents = {};
    for (let i = 0; i < n; i += 1) {
      const ps = [];
      for (let j = 0; j < i; j += 1) {
        if (rand() < 0.4) ps.push(depts[j]); // parents only from earlier nodes => DAG
      }
      parents[depts[i]] = ps;
    }
    const graph = new DeptGraph(parents);
    for (const dept of depts) {
      const expected = closureAncestors(depts, parents, dept);
      const actual = graph.ancestors(dept);
      assert.deepEqual([...actual].sort(), [...expected].sort(),
        `seed=${seed} dept=${dept}`);
      for (const other of depts) {
        assert.equal(graph.isAncestorOrSelf(other, dept),
          other === dept || expected.has(other),
          `seed=${seed} ${other} ancestor-of ${dept}`);
      }
    }
  }
});

test('authority inheritance: ancestor dept may approve, unrelated may not', () => {
  const { results, final } = run([
    { type: 'submit', request: 'r1', by: 'alice', dept: 'tf_ops', ts: 1 },
    { type: 'approve', request: 'r1', by: 'dave', ts: 2 },
    { type: 'approve', request: 'r1', by: 'erin', ts: 3 },
  ]);
  assert.ok(results[1].ok, 'treasury is an ancestor of tf_ops');
  assert.equal(results[2].code, 'E_AUTH', 'compliance is not an ancestor of tf_ops');
  assert.equal(final.requests.r1.state, 'PENDING');
});

test('audit hash is deterministic and tamper-evident', () => {
  const events = [
    { type: 'submit', request: 'r1', by: 'alice', dept: 'tf_ops', ts: 1 },
    { type: 'approve', request: 'r1', by: 'bob', ts: 2 },
    { type: 'approve', request: 'r1', by: 'carol', ts: 3 },
  ];
  const a = run(events).final.audit_hash;
  const b = run(events).final.audit_hash;
  assert.equal(a, b);
  const tampered = events.map((e) => ({ ...e }));
  tampered[1] = { ...tampered[1], ts: 99 };
  const c = run(tampered).final.audit_hash;
  assert.notEqual(a, c);
});
