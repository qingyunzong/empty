'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const os = require('os');

const { loadRulesText } = require('../src/ruleset');
const { compileSearchDFA, evaluateTokens } = require('../src/engine');
const { tokenizeTx } = require('../src/tokens');
const state = require('../src/state');

// Acceptance D: apply interrupted at explicit fault points (before writing
// decisions, after decisions but before checkpoint, after checkpoint but
// before commit) must recover without double-deducting quota.
// Fault injection throws FaultInjected at the exact crash point, leaving the
// partial journal on disk exactly as a crashed process would.
// Acceptance E: undo on an empty stack reports UNDO_EMPTY.

const RULES = 'XNF..\n';
const TXS = [
  { id: 't1', account: 'a1', amount: 100, hour: 10, region: 'domestic', channel: 'pos', history: false },
  { id: 't2', account: 'a1', amount: 200, hour: 11, region: 'domestic', channel: 'ecom', history: false },
  { id: 't3', account: 'a1', amount: 99999, hour: 2, region: 'foreign', channel: 'atm', history: false }, // XNF.. hit
];

function setup() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rc-test-'));
  return { statePath: path.join(dir, 'state.json') };
}

function decideAll() {
  const dfa = compileSearchDFA(loadRulesText(RULES));
  const tokens = TXS.map(tokenizeTx);
  const hits = evaluateTokens(dfa, tokens);
  return TXS.map((tx, i) => ({
    id: tx.id,
    account: tx.account,
    amount: tx.amount,
    token: tokens[i],
    decision: hits[i] ? 'REJECT' : 'ACCEPT',
    ...(hits[i] ? { reason: 'RULE_HIT' } : {}),
  }));
}

function usedQuota(statePath) {
  if (!fs.existsSync(statePath)) return 0;
  const st = JSON.parse(fs.readFileSync(statePath, 'utf8'));
  return st.accounts.a1 ? st.accounts.a1.used : 0;
}

test('D: clean apply deducts quota once; rejected tx has no freeze side effect', () => {
  const { statePath } = setup();
  const decisions = decideAll();
  assert.equal(decisions[2].decision, 'REJECT'); // t3 hits XNF..
  const r = state.applyRun({ statePath, decisions });
  assert.equal(r.decisions[2].decision, 'REJECT');
  assert.equal(usedQuota(statePath), 300); // t1+t2 only; t3 (99999) froze nothing
});

test('D: crash before-decision leaves no residue; retry applies once', () => {
  const { statePath } = setup();
  assert.throws(
    () => state.applyRun({ statePath, decisions: decideAll(), failAt: 'before-decision' }),
    (e) => e.code === 'FAULT_INJECTED' && e.point === 'before-decision'
  );
  assert.ok(!fs.existsSync(statePath));
  assert.ok(!fs.existsSync(`${statePath}.journal`) || fs.readdirSync(`${statePath}.journal`).length === 0);
  const r = state.applyRun({ statePath, decisions: decideAll() }); // no conflict
  assert.equal(usedQuota(statePath), 300);
  assert.ok(r.runId);
});

test('D: crash after-decision -> APPLY_CONFLICT -> recover (no commit) -> apply once', () => {
  const { statePath } = setup();
  assert.throws(
    () => state.applyRun({ statePath, decisions: decideAll(), failAt: 'after-decision' }),
    (e) => e.code === 'FAULT_INJECTED' && e.point === 'after-decision'
  );
  assert.throws(
    () => state.applyRun({ statePath, decisions: decideAll() }),
    (e) => e.code === 'APPLY_CONFLICT'
  );
  const rec = state.recover(statePath);
  assert.deepEqual(rec.recovered, []); // no checkpoint existed => nothing committed
  assert.equal(usedQuota(statePath), 0); // decisions alone never touch quota
  state.applyRun({ statePath, decisions: decideAll() });
  assert.equal(usedQuota(statePath), 300);
});

test('D: crash after-checkpoint -> recover commits exactly once (no double deduction)', () => {
  const { statePath } = setup();
  assert.throws(
    () => state.applyRun({ statePath, decisions: decideAll(), failAt: 'after-checkpoint' }),
    (e) => e.code === 'FAULT_INJECTED' && e.point === 'after-checkpoint'
  );
  assert.throws(
    () => state.applyRun({ statePath, decisions: decideAll() }),
    (e) => e.code === 'APPLY_CONFLICT'
  );
  const rec1 = state.recover(statePath);
  assert.equal(rec1.recovered.length, 1);
  assert.equal(usedQuota(statePath), 300);
  const rec2 = state.recover(statePath); // idempotent
  assert.equal(rec2.recovered.length, 0);
  assert.equal(usedQuota(statePath), 300); // not 600
});

test('D: undo reverts the last apply; quota restored', () => {
  const { statePath } = setup();
  state.applyRun({ statePath, decisions: decideAll() });
  assert.equal(usedQuota(statePath), 300);
  const u = state.undo(statePath);
  assert.ok(u.undoneRun);
  assert.equal(usedQuota(statePath), 0);
});

test('D: quota exhaustion rejects without deduction', () => {
  const { statePath } = setup();
  const decisions = decideAll();
  const r = state.applyRun({ statePath, decisions, quota: 250 });
  assert.equal(r.decisions[0].decision, 'ACCEPT'); // 100 <= 250
  assert.equal(r.decisions[1].decision, 'REJECT'); // 100+200 > 250
  assert.equal(r.decisions[1].reason, 'QUOTA_EXCEEDED');
  assert.equal(usedQuota(statePath), 100);
});

test('E: undo on empty stack reports UNDO_EMPTY', () => {
  const { statePath } = setup();
  assert.throws(() => state.undo(statePath), (e) => e.code === 'UNDO_EMPTY');
});

test('E: undo twice after a single apply reports UNDO_EMPTY', () => {
  const { statePath } = setup();
  state.applyRun({ statePath, decisions: decideAll() });
  state.undo(statePath);
  assert.throws(() => state.undo(statePath), (e) => e.code === 'UNDO_EMPTY');
});

test('stateHash is stable for identical states', () => {
  const a = setup();
  const b = setup();
  state.applyRun({ statePath: a.statePath, decisions: decideAll(), runId: 'run-fixed' });
  state.applyRun({ statePath: b.statePath, decisions: decideAll(), runId: 'run-fixed' });
  assert.equal(
    state.stateHash(state.loadState(a.statePath)),
    state.stateHash(state.loadState(b.statePath))
  );
});
