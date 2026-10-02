'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { parseLog, evaluate, HistError } = require('../index');

function log(lines) {
  return parseLog(lines.map((l) => JSON.stringify(l)).join('\n'));
}

test('acceptance 1: same ts, different seq boundaries', () => {
  const events = log([
    { ts: 10, seq: 1, op: 'rule', id: 'R1' },
    { ts: 10, seq: 2, op: 'trigger', rule: 'R1' },
    { ts: 10, seq: 3, op: 'revoke', rule: 'R1' },
  ]);
  assert.equal(evaluate(events, { asOf: '10:0' }).frozen, false, 'before seq 1');
  assert.equal(evaluate(events, { asOf: '10:1' }).frozen, false, 'rule defined, not yet triggered');
  const at2 = evaluate(events, { asOf: '10:2' });
  assert.equal(at2.frozen, true, 'trigger at seq 2 included');
  assert.equal(at2.rule, 'R1');
  assert.equal(evaluate(events, { asOf: '10:3' }).frozen, false, 'revoke at seq 3 included');
  assert.equal(evaluate(events, { asOf: '9:99' }).frozen, false, 'earlier ts sees nothing');
});

test('acceptance 1b: same ts ordered by seq, not file order', () => {
  const events = log([
    { ts: 10, seq: 5, op: 'trigger', rule: 'R1' },
    { ts: 10, seq: 1, op: 'rule', id: 'R1' },
    { ts: 10, seq: 3, op: 'revoke', rule: 'R1' },
  ]);
  // Replay order is seq 1 (rule), 3 (revoke), 5 (trigger of inactive rule -> no-op).
  const result = evaluate(events, { asOf: '10:9' });
  assert.equal(result.frozen, false, 'trigger after revoke on same ts must not freeze');
});

test('acceptance 2: revoke changes asOf before/after, not retroactively', () => {
  const events = log([
    { ts: 1, seq: 1, op: 'rule', id: 'R1' },
    { ts: 5, seq: 1, op: 'trigger', rule: 'R1' },
    { ts: 8, seq: 1, op: 'revoke', rule: 'R1' },
    { ts: 12, seq: 1, op: 'trigger', rule: 'R1' },
  ]);
  assert.equal(evaluate(events, { asOf: '6:0' }).frozen, true, 'between trigger and revoke');
  assert.equal(evaluate(events, { asOf: '7:0' }).frozen, true, 'revocation is not retroactive');
  const after = evaluate(events, { asOf: '9:0' });
  assert.equal(after.frozen, false, 'after revoke');
  assert.equal(after.rule, null);
  assert.deepEqual(
    after.explanation.map((e) => e.op),
    ['rule', 'trigger', 'revoke'],
    'explanation shows trigger then revoke'
  );
  assert.equal(evaluate(events, { asOf: '13:0' }).frozen, false, 'revoked rule cannot re-trigger');
});

test('acceptance 2b: re-defined rule can trigger again', () => {
  const events = log([
    { ts: 1, seq: 1, op: 'rule', id: 'R1' },
    { ts: 2, seq: 1, op: 'revoke', rule: 'R1' },
    { ts: 3, seq: 1, op: 'rule', id: 'R1' },
    { ts: 4, seq: 1, op: 'trigger', rule: 'R1' },
  ]);
  assert.equal(evaluate(events, { asOf: '5:0' }).frozen, true);
});

test('acceptance 3: fork, one branch freezes, merge is deny-first', () => {
  const events = log([
    { ts: 1, seq: 1, op: 'rule', id: 'R1' },
    { ts: 2, seq: 1, op: 'fork', branch: 'main', branches: ['b1', 'b2'] },
    { ts: 3, seq: 1, op: 'trigger', rule: 'R1', branch: 'b1' },
    { ts: 4, seq: 1, op: 'merge', branch: 'main', sources: ['b1', 'b2'] },
  ]);
  assert.equal(evaluate(events, { asOf: '3:2' }).frozen, false, 'main untouched before merge');
  assert.equal(evaluate(events, { asOf: '5:0', branch: 'b1' }).frozen, true, 'b1 frozen');
  assert.equal(evaluate(events, { asOf: '5:0', branch: 'b2' }).frozen, false, 'b2 not frozen');
  const merged = evaluate(events, { asOf: '5:0' });
  assert.equal(merged.frozen, true, 'merge takes deny over allow');
  assert.equal(merged.rule, 'R1');
  assert.deepEqual(
    merged.explanation.map((e) => e.op),
    ['rule', 'trigger', 'merge'],
    'minimal explanation: rule def + trigger + merge that carried it'
  );
});

test('acceptance 3b: merging only the clean branch does not freeze', () => {
  const events = log([
    { ts: 1, seq: 1, op: 'rule', id: 'R1' },
    { ts: 2, seq: 1, op: 'fork', branch: 'main', branches: ['b1', 'b2'] },
    { ts: 3, seq: 1, op: 'trigger', rule: 'R1', branch: 'b1' },
    { ts: 4, seq: 1, op: 'merge', branch: 'main', sources: ['b2'] },
  ]);
  assert.equal(evaluate(events, { asOf: '5:0' }).frozen, false);
});

test('acceptance 3c: deny survives even when other branch revoked', () => {
  const events = log([
    { ts: 1, seq: 1, op: 'rule', id: 'R1' },
    { ts: 2, seq: 1, op: 'fork', branch: 'main', branches: ['b1', 'b2'] },
    { ts: 3, seq: 1, op: 'trigger', rule: 'R1', branch: 'b1' },
    { ts: 3, seq: 2, op: 'revoke', rule: 'R1', branch: 'b2' },
    { ts: 4, seq: 1, op: 'merge', branch: 'main', sources: ['b1', 'b2'] },
  ]);
  const merged = evaluate(events, { asOf: '5:0' });
  assert.equal(merged.frozen, true, 'conflicting states resolve deny-first');
  assert.equal(merged.rule, 'R1');
});

test('group inheritance: rule scoped to trading group only freezes members', () => {
  const events = log([
    { ts: 1, seq: 1, op: 'rule', id: 'R1', group: 'G1' },
    { ts: 2, seq: 1, op: 'trigger', rule: 'R1' },
  ]);
  assert.equal(evaluate(events, { asOf: '3:0' }).frozen, false, 'account not in group yet');
  const events2 = log([
    { ts: 1, seq: 1, op: 'rule', id: 'R1', group: 'G1' },
    { ts: 2, seq: 1, op: 'join', account: 'default', group: 'G1' },
    { ts: 3, seq: 1, op: 'trigger', rule: 'R1' },
  ]);
  const res = evaluate(events2, { asOf: '4:0' });
  assert.equal(res.frozen, true);
  assert.deepEqual(res.explanation.map((e) => e.op), ['rule', 'join', 'trigger']);
});

test('per-account triggers do not freeze other accounts', () => {
  const events = log([
    { ts: 1, seq: 1, op: 'rule', id: 'R1' },
    { ts: 2, seq: 1, op: 'trigger', rule: 'R1', account: 'A' },
  ]);
  assert.equal(evaluate(events, { asOf: '3:0', account: 'A' }).frozen, true);
  assert.equal(evaluate(events, { asOf: '3:0', account: 'B' }).frozen, false);
  assert.equal(evaluate(events, { asOf: '3:0' }).frozen, false, 'default account unaffected');
});

test('E_FORK: structural branch errors', () => {
  const dup = log([
    { ts: 1, seq: 1, op: 'fork', branch: 'main', branches: ['b1'] },
    { ts: 2, seq: 1, op: 'fork', branch: 'main', branches: ['b1'] },
  ]);
  assert.throws(() => evaluate(dup, { asOf: '3:0' }), (e) => e instanceof HistError && e.code === 'E_FORK');

  const unknownSource = log([{ ts: 1, seq: 1, op: 'merge', branch: 'main', sources: ['nope'] }]);
  assert.throws(() => evaluate(unknownSource, { asOf: '2:0' }), (e) => e.code === 'E_FORK');

  const selfMerge = log([
    { ts: 1, seq: 1, op: 'fork', branch: 'main', branches: ['b1'] },
    { ts: 2, seq: 1, op: 'merge', branch: 'b1', sources: ['b1'] },
  ]);
  assert.throws(() => evaluate(selfMerge, { asOf: '3:0' }), (e) => e.code === 'E_FORK');

  const eventOnUnknown = log([{ ts: 1, seq: 1, op: 'trigger', rule: 'R1', branch: 'ghost' }]);
  assert.throws(() => evaluate(eventOnUnknown, { asOf: '2:0' }), (e) => e.code === 'E_FORK');

  const events = log([{ ts: 1, seq: 1, op: 'rule', id: 'R1' }]);
  assert.throws(() => evaluate(events, { asOf: '2:0', branch: 'ghost' }), (e) => e.code === 'E_FORK');
});

test('E_TIME: malformed times and as-of points', () => {
  assert.throws(() => parseLog('{"ts":"x","seq":1,"op":"rule","id":"R1"}'), (e) => e.code === 'E_TIME');
  assert.throws(() => parseLog('{"ts":1,"op":"rule","id":"R1"}'), (e) => e.code === 'E_TIME');
  assert.throws(() => parseLog('{"ts":-1,"seq":1,"op":"rule","id":"R1"}'), (e) => e.code === 'E_TIME');
  const events = log([{ ts: 1, seq: 1, op: 'rule', id: 'R1' }]);
  assert.throws(() => evaluate(events, { asOf: '10' }), (e) => e.code === 'E_TIME');
  assert.throws(() => evaluate(events, { asOf: 'a:b' }), (e) => e.code === 'E_TIME');
  assert.throws(() => evaluate(events, {}), (e) => e.code === 'E_TIME');
});

test('parseLog: skips blank lines and comments, keeps line numbers', () => {
  const events = parseLog('# header\n\n{"ts":1,"seq":1,"op":"rule","id":"R1"}\n');
  assert.equal(events.length, 1);
  assert.equal(events[0].line, 3);
});
