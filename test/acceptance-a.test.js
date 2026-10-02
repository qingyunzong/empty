import { test } from 'node:test';
import assert from 'node:assert/strict';
import { evaluate, verifyRecord } from '../src/evaluate.js';
import { referenceDecision } from '../src/reference.js';
import { makePolicy, BASE_POLICY, buildFiftyRequests } from './support/helpers.js';

const policies = makePolicy(BASE_POLICY);

test('A: 50 mixed inheritance+conflict requests all verify against reference', () => {
  const requests = buildFiftyRequests();
  assert.equal(requests.length, 50);

  const records = requests.map((req) => evaluate(policies, req));
  assert.equal(records.length, 50);

  let allows = 0;
  let conflicts = 0;
  let inheritanceAllows = 0;
  let lessSpecificOverrides = 0;
  let windowDenies = 0;
  for (let i = 0; i < records.length; i += 1) {
    const record = records[i];
    const req = requests[i];

    // every record carries auditable evidence
    assert.ok(Array.isArray(record.rulePath), `${record.requestId}: rulePath`);
    assert.ok(Array.isArray(record.overridden), `${record.requestId}: overridden`);
    assert.ok(record.counterexample, `${record.requestId}: counterexample`);

    // record is self-consistent and its counterexample really flips the outcome
    const check = verifyRecord(policies, req, record);
    assert.ok(check.ok, `${record.requestId}: ${check.problems.join('; ')}`);

    // engine agrees with the independent reference evaluator
    assert.equal(record.decision, referenceDecision(policies, req), `${record.requestId}: vs reference`);

    if (record.decision === 'allow') allows += 1;
    if (record.conflict) {
      conflicts += 1;
      assert.equal(record.decision, 'deny');
      assert.equal(record.conflict.resolution, 'deny');
      assert.ok(record.conflict.allow.length >= 1 && record.conflict.deny.length >= 1);
    }
    if (record.winners.includes('r-base-open')) inheritanceAllows += 1;
    if (record.overridden.some((o) => o.why === 'less-specific')) lessSpecificOverrides += 1;
    if (req.action === 'resetEstop' && record.decision === 'deny') windowDenies += 1;
  }

  assert.ok(allows > 0, 'some requests allowed');
  assert.ok(conflicts > 0, 'conflict certificates generated');
  assert.ok(inheritanceAllows > 0, 'allow via inherited anyone/plant rule');
  assert.ok(lessSpecificOverrides > 0, 'less-specific rules overridden');
  assert.ok(windowDenies > 0, 'window-closed denies present');
});

test('A: hand-computed spot checks', () => {
  const at = (action, subject = 'alice', device = 'press1', time = '2026-01-05T10:00:00Z') =>
    evaluate(policies, { id: 'spot', subject, device, action, time });

  // nearest rule wins: cellA deny (dist 2) beats plant-wide allow (dist 8)
  let r = at('openMold');
  assert.equal(r.decision, 'deny');
  assert.deepEqual(r.winners, ['r-deny-cellA']);
  assert.ok(r.overridden.some((o) => o.rule === 'r-base-open' && o.why === 'less-specific'));

  // inheritance: supervisor on press2 inherits anyone/plant allow
  r = at('openMold', 'bob', 'press2');
  assert.equal(r.decision, 'allow');
  assert.deepEqual(r.winners, ['r-base-open']);

  // same-level allow/deny conflict defaults to deny with a certificate
  r = at('heatUp');
  assert.equal(r.decision, 'deny');
  assert.equal(r.reason, 'conflict-deny');
  assert.deepEqual(r.conflict.allow, ['r-heat-allow']);
  assert.deepEqual(r.conflict.deny, ['r-heat-deny']);
  assert.ok(r.overridden.some((o) => o.rule === 'r-heat-allow' && o.why === 'conflict-deny-default'));

  // role chain cut: carol (user) is not an operator, wildcard deny applies
  r = at('heatUp', 'carol', 'press1');
  assert.equal(r.decision, 'deny');
  assert.deepEqual(r.winners, ['r-wild-deny']);

  // time window: inside allows, outside denies
  r = at('resetEstop', 'alice', 'press1', '2026-01-05T10:00:00Z');
  assert.equal(r.decision, 'allow');
  assert.deepEqual(r.winners, ['r-reset-window']);
  assert.equal(r.counterexample.kind, 'request');
  assert.equal(r.counterexample.resultingDecision, 'deny');
  r = at('resetEstop', 'alice', 'press1', '2026-01-05T20:00:00Z');
  assert.equal(r.decision, 'deny');
});
