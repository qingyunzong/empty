'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { Ledger, DepartmentGraph } = require('../src/ledger');

function setup() {
  const ledger = new Ledger();
  ledger.apply({ type: 'add_dept', dept: 'root' });
  ledger.apply({ type: 'add_dept', dept: 'trade', parents: ['root'] });
  ledger.apply({ type: 'add_dept', dept: 'trade-asia', parents: ['trade'] });
  ledger.apply({ type: 'add_dept', dept: 'ops', parents: ['root'] });
  ledger.apply({ type: 'add_member', member: 'alice', dept: 'trade-asia' });
  ledger.apply({ type: 'add_member', member: 'bob', dept: 'trade' });
  ledger.apply({ type: 'add_member', member: 'carol', dept: 'root' });
  ledger.apply({ type: 'add_member', member: 'dave', dept: 'trade-asia' });
  ledger.apply({ type: 'add_member', member: 'erin', dept: 'ops' });
  ledger.apply({ type: 'add_member', member: 'comply', dept: 'root', role: 'compliance' });
  ledger.apply({ type: 'submit', request: 'R1', submitter: 'alice', dept: 'trade-asia', amount: 50000 });
  return ledger;
}

test('1. dual approval by distinct authorized approvers disburses', () => {
  const ledger = setup();
  const t1 = ledger.apply({ type: 'approve', request: 'R1', approver: 'bob', decision: 'allow' });
  assert.equal(t1.ok, true);
  assert.equal(t1.from, 'PENDING');
  assert.equal(t1.to, 'PENDING');
  const t2 = ledger.apply({ type: 'approve', request: 'R1', approver: 'dave', decision: 'allow' });
  assert.equal(t2.ok, true);
  assert.equal(t2.from, 'PENDING');
  assert.equal(t2.to, 'DISBURSED');
  const report = ledger.report();
  assert.equal(report.requests.R1.state, 'DISBURSED');
  assert.match(report.auditHash, /^[0-9a-f]{64}$/);
  assert.equal(report.transitions.at(-1).hash, report.auditHash);
});

test('1b. audit hash is deterministic for identical event streams', () => {
  const a = setup();
  const b = setup();
  for (const ledger of [a, b]) {
    ledger.apply({ type: 'approve', request: 'R1', approver: 'bob', decision: 'allow' });
    ledger.apply({ type: 'approve', request: 'R1', approver: 'dave', decision: 'allow' });
  }
  assert.equal(a.report().auditHash, b.report().auditHash);
});

test('1c. approval authority inherits down the department DAG', () => {
  const ledger = setup();
  const ok = ledger.apply({ type: 'approve', request: 'R1', approver: 'carol', decision: 'allow' });
  assert.equal(ok.ok, true);
  const denied = ledger.apply({ type: 'approve', request: 'R1', approver: 'erin', decision: 'allow' });
  assert.equal(denied.ok, false);
  assert.equal(denied.error, 'E_AUTHORITY');
  assert.equal(ledger.report().requests.R1.state, 'PENDING');
});

test('2. duplicate approval by the same approver is invalid', () => {
  const ledger = setup();
  ledger.apply({ type: 'approve', request: 'R1', approver: 'bob', decision: 'allow' });
  const dup = ledger.apply({ type: 'approve', request: 'R1', approver: 'bob', decision: 'allow' });
  assert.equal(dup.ok, false);
  assert.equal(dup.error, 'E_DUPLICATE');
  const req = ledger.report().requests.R1;
  assert.equal(req.state, 'PENDING');
  assert.equal(req.approvals.length, 1);
});

test('3. approvals during freeze are recorded and take effect after unfreeze', () => {
  const ledger = setup();
  ledger.apply({ type: 'freeze', request: 'R1', by: 'comply' });
  const a1 = ledger.apply({ type: 'approve', request: 'R1', approver: 'bob', decision: 'allow', ts: 10 });
  const a2 = ledger.apply({ type: 'approve', request: 'R1', approver: 'dave', decision: 'allow', ts: 11 });
  assert.equal(a1.ok, true);
  assert.equal(a1.effective, false);
  assert.equal(a2.effective, false);
  let req = ledger.report().requests.R1;
  assert.equal(req.state, 'PENDING');
  assert.equal(req.frozen, true);
  assert.deepEqual(req.approvals.map((a) => a.effective), [false, false]);
  const un = ledger.apply({ type: 'unfreeze', request: 'R1', by: 'comply' });
  assert.equal(un.ok, true);
  assert.deepEqual(un.activated, ['bob', 'dave']);
  assert.equal(un.to, 'DISBURSED');
  req = ledger.report().requests.R1;
  assert.equal(req.state, 'DISBURSED');
  assert.deepEqual(req.approvals.map((a) => a.effective), [true, true]);
});

test('3b. conflict priority: freeze gates, then deny beats allow', () => {
  const ledger = setup();
  ledger.apply({ type: 'freeze', request: 'R1', by: 'comply' });
  ledger.apply({ type: 'approve', request: 'R1', approver: 'bob', decision: 'allow', ts: 1 });
  ledger.apply({ type: 'approve', request: 'R1', approver: 'dave', decision: 'deny', ts: 2 });
  ledger.apply({ type: 'approve', request: 'R1', approver: 'carol', decision: 'allow', ts: 3 });
  const un = ledger.apply({ type: 'unfreeze', request: 'R1', by: 'comply' });
  assert.equal(un.to, 'REJECTED');
  assert.equal(ledger.report().requests.R1.state, 'REJECTED');
});

test('3c. freeze requires compliance role', () => {
  const ledger = setup();
  const bad = ledger.apply({ type: 'freeze', request: 'R1', by: 'bob' });
  assert.equal(bad.ok, false);
  assert.equal(bad.error, 'E_AUTHORITY');
  assert.equal(ledger.report().requests.R1.frozen, false);
});

test('4. revoke after disbursement reports E_FINAL', () => {
  const ledger = setup();
  ledger.apply({ type: 'approve', request: 'R1', approver: 'bob', decision: 'allow' });
  ledger.apply({ type: 'approve', request: 'R1', approver: 'dave', decision: 'allow' });
  assert.equal(ledger.report().requests.R1.state, 'DISBURSED');
  const revoked = ledger.apply({ type: 'revoke', request: 'R1', approver: 'bob', by: 'bob' });
  assert.equal(revoked.ok, false);
  assert.equal(revoked.error, 'E_FINAL');
  assert.equal(ledger.report().requests.R1.state, 'DISBURSED');
});

test('4b. revoke before disbursement allowed for self and superior only', () => {
  const ledger = setup();
  ledger.apply({ type: 'approve', request: 'R1', approver: 'bob', decision: 'allow' });
  const self = ledger.apply({ type: 'revoke', request: 'R1', approver: 'bob', by: 'bob' });
  assert.equal(self.ok, true);
  assert.equal(ledger.report().requests.R1.approvals.length, 0);
  ledger.apply({ type: 'approve', request: 'R1', approver: 'dave', decision: 'allow' });
  const peer = ledger.apply({ type: 'revoke', request: 'R1', approver: 'dave', by: 'erin' });
  assert.equal(peer.ok, false);
  assert.equal(peer.error, 'E_AUTHORITY');
  const superior = ledger.apply({ type: 'revoke', request: 'R1', approver: 'dave', by: 'carol' });
  assert.equal(superior.ok, true);
  assert.equal(ledger.report().requests.R1.approvals.length, 0);
});

function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function randomDag(rng, n) {
  const parents = new Map();
  for (let i = 0; i < n; i++) {
    const ps = [];
    for (let j = 0; j < i; j++) {
      if (rng() < 0.3) ps.push('d' + j);
    }
    parents.set('d' + i, ps);
  }
  return parents;
}

function enumAncestors(parents, dept) {
  const seen = new Set([dept]);
  let grew = true;
  while (grew) {
    grew = false;
    for (const d of [...seen]) {
      for (const p of parents.get(d)) {
        if (!seen.has(p)) {
          seen.add(p);
          grew = true;
        }
      }
    }
  }
  return seen;
}

test('5. random department DAGs: ancestors match brute-force enumeration', () => {
  const rng = mulberry32(20261003);
  for (let trial = 0; trial < 200; trial++) {
    const n = 1 + Math.floor(rng() * 8);
    const parents = randomDag(rng, n);
    const graph = new DepartmentGraph();
    for (const [dept, ps] of parents) graph.add(dept, ps);
    for (const dept of parents.keys()) {
      const expected = enumAncestors(parents, dept);
      const actual = graph.ancestorsOf(dept);
      assert.deepEqual([...actual].sort(), [...expected].sort(), `trial ${trial} dept ${dept}`);
      for (const other of parents.keys()) {
        assert.equal(
          graph.isAncestorOrSelf(other, dept),
          expected.has(other),
          `trial ${trial}: isAncestorOrSelf(${other}, ${dept})`
        );
      }
    }
  }
});
