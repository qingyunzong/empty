'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { parse, derivMatch, FlowError } = require('../src/regex');
const { compileFlow } = require('../src/automata');
const { checkFlow, MAX_LOG } = require('../src/audit');
const { equivFlows, enumerateDistinguisher } = require('../src/equiv');

const FLOW = '申请 复核 放行 入账';

function replay(dfa, witness) {
  assert.equal(witness.states[0], dfa.start);
  let cur = dfa.start;
  for (let i = 0; i < witness.events.length; i++) {
    const next = dfa.trans[cur].get(witness.events[i]);
    assert.notEqual(next, undefined, `no transition for ${witness.events[i]}`);
    assert.equal(next, witness.states[i + 1]);
    cur = next;
  }
  return cur;
}

test('A: legal flow accepted, witness path replays to an accepting state', () => {
  const events = ['申请', '复核', '放行', '入账'];
  const res = checkFlow(FLOW, events);
  assert.equal(res.accept, true);
  assert.deepEqual(res.repairs, []);
  const { dfa } = compileFlow(FLOW);
  const end = replay(dfa, res.witness);
  assert.ok(dfa.finals.has(end), 'witness must end in an accepting state');
  assert.equal(res.witness.states.length, events.length + 1);
});

test('B: missing 复核 yields an insert repair', () => {
  const res = checkFlow(FLOW, ['申请', '放行', '入账']);
  assert.equal(res.accept, false);
  assert.equal(res.minCost, 1);
  assert.deepEqual(res.repairs, [[{ op: 'insert', event: '复核', at: 1 }]]);
});

test('C: all tied optimal repairs are listed', () => {
  const res = checkFlow('申请 (复核|放行) 入账', ['申请', '入账']);
  assert.equal(res.accept, false);
  assert.equal(res.minCost, 1);
  assert.equal(res.repairs.length, 2);
  assert.deepEqual(res.repairs, [
    [{ op: 'insert', event: '复核', at: 1 }],
    [{ op: 'insert', event: '放行', at: 1 }],
  ]);
});

test('C2: substitution costs delete+insert (2), ties capped at 10 plans', () => {
  // log has 入账 where 复核 belongs: cheapest fix is delete 入账 + insert 复核
  const res = checkFlow('申请 复核 入账', ['申请', '入账', '入账']);
  assert.equal(res.minCost, 2);
  assert.ok(res.repairs.length >= 1);
  for (const plan of res.repairs) {
    assert.equal(plan.reduce((c) => c + 1, 0), 2);
  }
});

function applyRepair(events, plan) {
  const out = [];
  for (let i = 0; i <= events.length; i++) {
    for (const op of plan) if (op.op === 'insert' && op.at === i) out.push(op.event);
    if (i < events.length && !plan.some((op) => op.op === 'delete' && op.at === i)) out.push(events[i]);
  }
  return out;
}

test('repairs are replayable: applying a plan makes the log accepted', () => {
  const flow = '申请 复核 放行 入账 (冲正 入账)*';
  const log = ['申请', '放行', '入账', '冲正', '复核'];
  const res = checkFlow(flow, log);
  assert.equal(res.accept, false);
  assert.ok(res.repairs.length >= 1);
  for (const plan of res.repairs) {
    const fixed = applyRepair(log, plan);
    const again = checkFlow(flow, fixed);
    assert.equal(again.accept, true, `plan ${JSON.stringify(plan)} -> ${JSON.stringify(fixed)}`);
  }
});

test('repair plans are capped at 10 even with more ties', () => {
  const alts = [];
  const evs = ['申请', '复核', '放行', '入账', '冲正'];
  for (const a of evs) for (const b of evs) alts.push(`(${a} ${b})`);
  const res = checkFlow(alts.join('|'), []);
  assert.equal(res.minCost, 2);
  assert.equal(res.repairs.length, 10);
  // lexicographic order by event name
  const sigs = res.repairs.map((p) => p.map((o) => o.event).join(''));
  const sorted = [...sigs].sort();
  assert.deepEqual(sigs, sorted);
});

test('D: exhaustive enumeration len<=7 over 5 events, DFA == derivative matcher', () => {
  const src = '申请 复核* 放行? 入账 (冲正 入账?)*';
  const { ast, dfa, alphabet } = compileFlow(src);
  assert.equal(alphabet.length, 5);
  let checked = 0;
  function walk(node, state, len) {
    const dfaAccepts = state !== -1 && dfa.finals.has(state);
    assert.equal(dfaAccepts, require('../src/regex').nullable(node), `mismatch at len ${len}`);
    checked++;
    if (len === 7) return;
    for (const a of alphabet) {
      const nextState = state === -1 ? -1 : (dfa.trans[state].get(a) ?? -1);
      walk(require('../src/regex').derive(node, a), nextState, len + 1);
    }
  }
  walk(ast, dfa.start, 0);
  assert.equal(checked, (5 ** 8 - 1) / 4); // 97656 strings
  // sanity: derivative matcher agrees with itself via derivMatch on samples
  assert.equal(derivMatch(parse(src), ['申请', '入账']), true);
  assert.equal(derivMatch(parse(src), ['复核']), false);
});

test('E: repair beyond K=6 reports NO_REPAIR_WITHIN_K', () => {
  const res = checkFlow(FLOW, Array(7).fill('放行'));
  assert.equal(res.accept, false);
  assert.equal(res.error, 'NO_REPAIR_WITHIN_K');
  assert.deepEqual(res.repairs, []);
});

test('edge: empty log accepted iff regex accepts empty string', () => {
  assert.equal(checkFlow('申请?', []).accept, true);
  const res = checkFlow(FLOW, []);
  assert.equal(res.accept, false);
  assert.equal(res.minCost, 4);
});

test('edge: unknown event rejected immediately', () => {
  const res = checkFlow(FLOW, ['申请', '复核', '盖章', '放行', '入账']);
  assert.equal(res.accept, false);
  assert.deepEqual(res.reason, { reason: 'UNKNOWN_EVENT', at: 2, event: '盖章' });
});

test('edge: 冲正 cannot undo a non-posted entry', () => {
  const res = checkFlow('申请 复核 放行 入账 冲正*', ['申请', '复核', '放行', '冲正']);
  assert.equal(res.accept, false);
  assert.equal(res.reason.reason, 'REVERSAL_WITHOUT_POSTING');
  assert.equal(res.reason.at, 3);
  // balanced reversal after posting is fine
  const ok = checkFlow('申请 复核 放行 入账 (冲正 入账)*', ['申请', '复核', '放行', '入账', '冲正', '入账']);
  assert.equal(ok.accept, true);
});

test('error: LOG_TOO_LONG beyond 200 events', () => {
  assert.throws(() => checkFlow('申请*', Array(MAX_LOG + 1).fill('申请')),
    (e) => e.code === 'LOG_TOO_LONG');
});

test('error: EMPTY_ALPHABET for regex without events', () => {
  assert.throws(() => checkFlow('ε*', []), (e) => e.code === 'EMPTY_ALPHABET');
});

test('error: NONTERM_AUTOMATON for empty language', () => {
  assert.throws(() => checkFlow('申请 ∅', ['申请']), (e) => e.code === 'NONTERM_AUTOMATON');
});

test('equiv: equivalent flows, and distinguishing witness reproduced by enumerator', () => {
  const eq = equivFlows('申请 (复核 申请)*', '(申请 复核)* 申请');
  assert.equal(eq.equiv, true);
  assert.equal(eq.witness, null);

  const ne = equivFlows('申请 复核', '申请 放行');
  assert.equal(ne.equiv, false);
  assert.deepEqual(ne.witness, ['申请', '复核']);
  assert.equal(ne.reproduced, true);

  // enumerator independently finds the same witness
  const { ast: a1 } = compileFlow('申请 复核');
  const { ast: a2 } = compileFlow('申请 放行');
  assert.deepEqual(enumerateDistinguisher(a1, a2, ['复核', '放行', '申请'], 2), ['申请', '复核']);
});

test('CLI: check and equiv end-to-end (in-process main)', () => {
  const { main } = require('../cli');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'audit-'));
  const flow = path.join(dir, 'flow.re');
  const log = path.join(dir, 'log.jsonl');
  fs.writeFileSync(flow, FLOW + '\n');
  fs.writeFileSync(log, '{"event":"申请"}\n{"event":"放行"}\n{"event":"入账"}\n');
  const out = main(['check', flow, log]);
  assert.equal(out.accept, false);
  assert.deepEqual(out.repairs, [[{ op: 'insert', event: '复核', at: 1 }]]);

  const flow2 = path.join(dir, 'flow2.re');
  fs.writeFileSync(flow2, '申请 复核 放行 入账 冲正?日志占位\n'.replace('日志占位','') + '\n');
  fs.writeFileSync(flow2, '申请 复核 放行 入账 冲正?\n');
  const eq = main(['equiv', flow, flow2]);
  assert.equal(eq.equiv, false);
  assert.deepEqual(eq.witness, ['申请', '复核', '放行', '入账', '冲正']);
  assert.equal(eq.reproduced, true);
});

test('CLI: error codes surface', () => {
  const { main } = require('../cli');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'audit-'));
  const flow = path.join(dir, 'flow.re');
  const log = path.join(dir, 'log.jsonl');
  fs.writeFileSync(flow, '\u03b5\n');
  fs.writeFileSync(log, '');
  assert.throws(() => main(['check', flow, log]), (e) => e.code === 'EMPTY_ALPHABET');
});
