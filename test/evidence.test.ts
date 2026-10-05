import { test } from 'node:test';
import assert from 'node:assert/strict';
import { checkEvidenceAgainstEventModel } from '../src/evidence.js';
import type { ResolutionEvidence } from '../src/evidence.js';
import { setup } from './helpers.js';

function mixedScenario() {
  const rig = setup();
  const { ledger, engine } = rig;
  ledger.grant(1, 'alice', 'dataset');
  engine.openBatch(2, 'b1', 'alice', 'dataset');
  engine.cacheBlock('b1', { id: 'blk-1', data: 'aaa' });
  engine.commit(3, 'b1', 'object-1');

  engine.openBatch(4, 'b2', 'alice', 'dataset');
  engine.cacheBlock('b2', { id: 'blk-2', data: 'bbb' });
  engine.suspend('b2');
  ledger.revoke(5, 'alice', 'dataset');
  engine.resume(6, 'b2');
  engine.commit(7, 'b2', 'object-1');

  ledger.grant(8, 'alice', 'dataset');
  engine.openBatch(9, 'b3', 'alice', 'dataset');
  engine.cacheBlock('b3', { id: 'blk-3', data: 'ccc' });
  engine.commit(10, 'b3', 'object-1');
  return rig;
}

test('every decision evidence checks out against the event model', () => {
  const { log, engine } = mixedScenario();
  assert.equal(engine.evidence.length, 7);
  for (const evidence of engine.evidence) {
    const result = checkEvidenceAgainstEventModel(log.all(), evidence);
    assert.deepEqual(result.mismatches, [], `evidence at seq ${evidence.decidedAtSeq}`);
    assert.ok(result.ok);
  }
});

test('evidence records bound version, effective permission and consulted events', () => {
  const { ledger, engine } = setup();
  const grant = ledger.grant(1, 'alice', 'dataset');
  engine.openBatch(2, 'b1', 'alice', 'dataset');
  engine.cacheBlock('b1', { id: 'blk-1', data: 'aaa' });
  const revoke = ledger.revoke(3, 'alice', 'dataset');
  const evidence = engine.commit(4, 'b1', 'object-1');

  assert.equal(evidence.boundPermissionVersion, 1);
  assert.equal(evidence.effectivePermission!.effect, 'deny');
  assert.equal(evidence.effectivePermission!.sourceEventSeq, revoke.seq);
  assert.ok(evidence.consultedEventSeqs.includes(grant.seq));
  assert.ok(evidence.consultedEventSeqs.includes(revoke.seq));
  assert.ok(evidence.consultedEventSeqs.includes(2));
});

test('tampered evidence is caught by the event model check', () => {
  const { log, engine } = mixedScenario();
  const original = engine.evidence.find((e) => e.operation === 'commit' && e.decision === 'rejected')!;
  const tampered: ResolutionEvidence = { ...original, decision: 'accepted' };
  const result = checkEvidenceAgainstEventModel(log.all(), tampered);
  assert.equal(result.ok, false);
  assert.ok(result.mismatches.some((m) => m.includes('decision mismatch')));
});

test('evidence referencing a foreign event log is caught', () => {
  const { engine } = mixedScenario();
  const other = setup();
  const result = checkEvidenceAgainstEventModel(other.log.all(), engine.evidence[0]!);
  assert.equal(result.ok, false);
});
