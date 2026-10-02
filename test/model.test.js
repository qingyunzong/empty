'use strict';
// Acceptance 1: random 300-event log (with voids) cross-checked against an
// independent reference state machine, plus exhaustive enumeration of all
// event sequences up to length 6 (and random sequences up to length 10).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { ERR, initialState, applyEvent, project, guard } = require('../src/model');
const { refProject } = require('./refmodel');
const { run } = require('../cli');

function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function compareSequence(seq) {
  let state = initialState();
  for (let i = 0; i < seq.length; i++) {
    const g = guard(state, seq[i]);
    if (!g.ok) {
      let refErr = null;
      try {
        refProject(seq.slice(0, i + 1));
      } catch (e) {
        refErr = e;
      }
      assert.ok(refErr, `lib rejected with ${g.code} but ref accepted: ${JSON.stringify(seq)}`);
      assert.equal(refErr.code, g.code, `code mismatch on ${JSON.stringify(seq[i])}`);
      return;
    }
    applyEvent(state, seq[i]);
  }
  // Lib accepted the whole prefix; the reference must agree on the final state.
  assert.deepStrictEqual(state.accounts, refProject(seq).accounts);
}

test('exhaustive enumeration of all sequences up to length 5 matches reference', () => {
  const alphabet = [
    { type: 'sale', id: 's1', account: 'a', amount: 50 },
    { type: 'sale', id: 's2', account: 'a', amount: 30 },
    { type: 'refund', id: 'r1', saleId: 's1', account: 'a', amount: 20 },
    { type: 'refund', id: 'r2', saleId: 's1', account: 'a', amount: 40 },
    { type: 'refundVoid', refundId: 'r1' },
    { type: 'freeze', account: 'a', amount: 10 },
    { type: 'unfreeze', account: 'a', amount: 10 },
  ];
  let checked = 0;
  const walk = (prefix, depth) => {
    compareSequence(prefix);
    checked++;
    if (depth === 0) return;
    for (const ev of alphabet) walk([...prefix, ev], depth - 1);
  };
  for (const ev of alphabet) walk([ev], 4);
  assert.ok(checked > 10000, `expected >10k sequences, got ${checked}`);
});

test('random sequences up to length 10 match reference', () => {
  const rand = mulberry32(17);
  const accounts = ['a', 'b'];
  const pick = (arr) => arr[Math.floor(rand() * arr.length)];
  for (let n = 0; n < 8000; n++) {
    const len = 1 + Math.floor(rand() * 10);
    const seq = [];
    for (let i = 0; i < len; i++) {
      const kind = rand();
      const account = pick(accounts);
      if (kind < 0.3) seq.push({ type: 'sale', id: `s${Math.floor(rand() * 4)}`, account, amount: 10 + Math.floor(rand() * 90) });
      else if (kind < 0.55) seq.push({ type: 'refund', id: `r${Math.floor(rand() * 4)}`, saleId: `s${Math.floor(rand() * 4)}`, account, amount: 5 + Math.floor(rand() * 60) });
      else if (kind < 0.7) seq.push({ type: 'refundVoid', refundId: `r${Math.floor(rand() * 4)}` });
      else if (kind < 0.85) seq.push({ type: 'freeze', account, amount: 5 + Math.floor(rand() * 40) });
      else seq.push({ type: 'unfreeze', account, amount: 5 + Math.floor(rand() * 40) });
    }
    compareSequence(seq);
  }
});

function genValidLog(seed, count) {
  const rand = mulberry32(seed);
  const accounts = ['alice', 'bob', 'carol'];
  const log = [];
  let state = initialState();
  let saleSeq = 0;
  let refundSeq = 0;
  const pick = (arr) => arr[Math.floor(rand() * arr.length)];
  while (log.length < count) {
    const account = pick(accounts);
    const kind = rand();
    let ev;
    if (kind < 0.3 || saleSeq === 0) {
      ev = { type: 'sale', id: `sale-${saleSeq++}`, account, amount: 50 + Math.floor(rand() * 200) };
    } else if (kind < 0.55) {
      const saleIds = Object.keys(state.sales);
      if (saleIds.length === 0) continue;
      const saleId = pick(saleIds);
      ev = { type: 'refund', id: `rf-${refundSeq++}`, saleId, account: state.sales[saleId].account, amount: 1 + Math.floor(rand() * 120) };
    } else if (kind < 0.7) {
      const stack = state.refundStack[account];
      if (!stack || stack.length === 0) continue;
      ev = { type: 'refundVoid', refundId: stack[stack.length - 1] };
    } else if (kind < 0.85) {
      ev = { type: 'freeze', account, amount: 1 + Math.floor(rand() * 80) };
    } else {
      ev = { type: 'unfreeze', account, amount: 1 + Math.floor(rand() * 80) };
    }
    const g = guard(state, ev);
    if (g.ok) {
      applyEvent(state, ev);
      log.push(ev);
    }
  }
  return log;
}

test('random 300-event log with voids: project matches reference and invariants hold', () => {
  const log = genValidLog(30017, 300);
  assert.equal(log.length, 300);
  assert.ok(log.some((e) => e.type === 'refundVoid'), 'log must contain voids');
  const libState = project(log);
  const refState = refProject(log);
  assert.deepStrictEqual(libState.accounts, refState.accounts);
  for (const [name, a] of Object.entries(libState.accounts)) {
    assert.ok(a.frozen >= 0, `${name} frozen negative`);
    assert.ok(a.balance >= a.frozen, `${name} balance < frozen`);
  }
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'proj-'));
  const file = path.join(dir, 'events.jsonl');
  fs.writeFileSync(file, log.map((e) => JSON.stringify(e)).join('\n') + '\n');
  const res = run(['project', file]);
  assert.equal(res.code, 0);
  assert.deepStrictEqual(JSON.parse(res.stdout).accounts, libState.accounts);
});

test('guard error codes: dangling 30, duplicate/over refund 31, frozen 32', () => {
  let state = initialState();
  assert.equal(guard(state, { type: 'refund', id: 'r1', saleId: 'nope', account: 'a', amount: 5 }).code, ERR.DANGLING_REF);
  assert.equal(guard(state, { type: 'refundVoid', refundId: 'nope' }).code, ERR.DANGLING_REF);
  applyEvent(state, { type: 'sale', id: 's1', account: 'a', amount: 100 });
  applyEvent(state, { type: 'refund', id: 'r1', saleId: 's1', account: 'a', amount: 100 });
  assert.equal(guard(state, { type: 'refund', id: 'r2', saleId: 's1', account: 'a', amount: 1 }).code, ERR.DUPLICATE_REFUND);
  assert.equal(guard(state, { type: 'refund', id: 'r1', saleId: 's1', account: 'a', amount: 1 }).code, ERR.DUPLICATE_REFUND);
  state = initialState();
  applyEvent(state, { type: 'sale', id: 's1', account: 'a', amount: 100 });
  assert.equal(guard(state, { type: 'refund', id: 'r1', saleId: 's1', account: 'a', amount: 101 }).code, ERR.DUPLICATE_REFUND);
  assert.equal(guard(state, { type: 'unfreeze', account: 'a', amount: 101 }).code, ERR.INSUFFICIENT_FROZEN);
  assert.equal(guard(state, { type: 'freeze', account: 'a', amount: 1 }).code, ERR.INSUFFICIENT_FROZEN);
});

test('refund with insufficient frozen rolls back entirely (no partial mutation)', () => {
  const state = initialState();
  applyEvent(state, { type: 'sale', id: 's1', account: 'a', amount: 50 });
  applyEvent(state, { type: 'unfreeze', account: 'a', amount: 50 });
  const before = structuredClone(state);
  const g = guard(state, { type: 'refund', id: 'r1', saleId: 's1', account: 'a', amount: 50 });
  assert.equal(g.code, ERR.INSUFFICIENT_FROZEN);
  assert.deepStrictEqual(state, before);
  assert.equal(state.sales.s1.refunded, 0);
});

test('refundVoid only voids the most recent active refund', () => {
  const state = initialState();
  applyEvent(state, { type: 'sale', id: 's1', account: 'a', amount: 100 });
  applyEvent(state, { type: 'refund', id: 'r1', saleId: 's1', account: 'a', amount: 10 });
  applyEvent(state, { type: 'refund', id: 'r2', saleId: 's1', account: 'a', amount: 20 });
  assert.equal(guard(state, { type: 'refundVoid', refundId: 'r1' }).code, ERR.VOID_NOT_ALLOWED);
  applyEvent(state, { type: 'refundVoid', refundId: 'r2' });
  assert.equal(state.accounts.a.balance, 90);
  assert.equal(state.accounts.a.frozen, 90);
  assert.equal(state.sales.s1.refunded, 10);
  assert.equal(guard(state, { type: 'refundVoid', refundId: 'r2' }).code, ERR.VOID_NOT_ALLOWED);
  applyEvent(state, { type: 'refundVoid', refundId: 'r1' });
  assert.equal(state.sales.s1.refunded, 0);
  assert.deepStrictEqual(state.accounts.a, { balance: 100, frozen: 100 });
});
