'use strict';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { InvertedIndex } from '../src/index.js';
import { Store, StoreError } from '../src/store.js';
import { normalizeQuery } from '../src/text.js';

const DOCS = [
  { id: 'D01', batchId: 'B1', description: '裂纹扩展', defectCode: 'CRK01', batchCode: 'LOT100' },
  { id: 'D02', batchId: 'B1', description: '渗漏', defectCode: 'LEA01', batchCode: 'LOT101' },
  { id: 'D03', batchId: 'B1', description: '纹扩', defectCode: 'CRK02', batchCode: 'LOT100' },
  { id: 'D04', batchId: 'B2', description: '裂漏纹', defectCode: 'CRK01', batchCode: 'LOT102' },
  { id: 'D05', batchId: 'B2', description: '扩渗漏展', defectCode: 'LEA02', batchCode: 'CRK01' },
  { id: 'D06', batchId: 'B2', description: '展纹裂', defectCode: 'CRK03', batchCode: 'LOT100' },
  { id: 'D07', batchId: 'B3', description: '裂纹漏', defectCode: 'LEA01', batchCode: 'LOT103' },
  { id: 'D08', batchId: 'B3', description: '渗扩展', defectCode: 'CRK02', batchCode: 'LOT104' },
  { id: 'D09', batchId: 'B3', description: '漏', defectCode: 'CRK04', batchCode: 'LOT105' },
  { id: 'D10', batchId: 'B3', description: '纹', defectCode: 'CRK05', batchCode: 'LOT106' },
];

function buildIndex() {
  const ix = new InvertedIndex();
  for (const d of DOCS) ix.addDocument(d);
  return ix;
}

function* allQueries() {
  const alphabet = ['裂', '纹', '扩', '展', '漏', '渗'];
  const phrases = [];
  for (const a of alphabet) phrases.push(a);
  for (const a of alphabet) for (const b of alphabet) phrases.push(a + b);
  for (const a of alphabet) for (const b of alphabet) for (const c of alphabet) phrases.push(a + b + c);
  phrases.push('朽', '裂纹 扩展', 'abc', '裂 纹  扩'); // absent char, spaced, latin, odd spaces
  const codes = new Set();
  for (const d of DOCS) { codes.add(d.defectCode); codes.add(d.batchCode); }
  const codeQueries = new Set(['ZZZ9', 'X', '']);
  for (const c of codes) {
    codeQueries.add(c);
    codeQueries.add(c.toLowerCase());
    codeQueries.add(c + 'X');
    for (let i = 0; i < c.length; i++) {
      codeQueries.add(c.slice(0, i) + c.slice(i + 1));       // deletion
      codeQueries.add(c.slice(0, i) + 'X' + c.slice(i + 1)); // substitution
    }
  }
  const codeList = [...codeQueries];
  for (const p of phrases) yield { phrase: p };
  for (const c of codeList) yield { defectCode: c };
  for (const c of codeList) yield { batchCode: c };
  // combined conditions (deterministic sample of the cross product)
  for (let i = 0; i < phrases.length; i += 7) {
    for (let j = 0; j < codeList.length; j += 11) {
      yield { phrase: phrases[i], defectCode: codeList[j] };
      yield { phrase: phrases[i], defectCode: codeList[j], batchCode: codeList[(j + 3) % codeList.length] };
    }
  }
}

test('acceptance 1: exhaustive query enumeration matches brute force', () => {
  const ix = buildIndex();
  let count = 0;
  for (const q of allQueries()) {
    const nq = normalizeQuery(q);
    if (!nq.phraseTokens.length && !nq.defectCode && !nq.batchCode) continue;
    const viaIndex = ix.search(nq).toArray();
    const viaBrute = ix.bruteForce(nq).toArray();
    assert.deepEqual(viaIndex, viaBrute, 'mismatch for query ' + JSON.stringify(q));
    count++;
  }
  assert.ok(count > 1500, 'expected a large enumeration, got ' + count);
  // sanity: the headline phrase actually recalls something
  const hits = ix.search(normalizeQuery({ phrase: '裂纹 扩展' })).toArray();
  assert.ok(hits.length > 0);
});

test('acceptance 2: repeated identical recall is idempotent, epoch unchanged', () => {
  const s = new Store();
  s.loadBatch({ batchId: 'B1', docs: DOCS.filter((d) => d.batchId === 'B1') });
  const epochAfterLoad = s.epoch;
  const r1 = s.recall({ phrase: '裂纹 扩展' });
  assert.equal(r1.created, true);
  const epochAfterRecall = s.epoch;
  // same text (different whitespace/case) + same conditions -> same recall, no epoch bump
  const r2 = s.recall({ phrase: '裂纹  扩展' });
  assert.equal(r2.created, false);
  assert.equal(r2.rec.id, r1.rec.id);
  assert.equal(s.epoch, epochAfterRecall);
  const r3 = s.recall({ phrase: '裂纹 扩展' }, 'whatever-name');
  assert.equal(r3.created, false);
  assert.equal(r3.rec.id, r1.rec.id);
  assert.equal(s.epoch, epochAfterRecall);
  // certificates identical
  assert.equal(r1.rec.queryHash, r2.rec.queryHash);
  assert.equal(r1.rec.hitsHash, r2.rec.hitsHash);
  // a *different* query does bump the epoch
  const r4 = s.recall({ phrase: '渗漏' });
  assert.equal(r4.created, true);
  assert.ok(s.epoch > epochAfterRecall);
  assert.ok(epochAfterRecall > epochAfterLoad);
  // reusing a name with a different query -> E_DUP
  s.recall({ phrase: '漏' }, 'TAKEN');
  assert.throws(() => s.recall({ phrase: '纹' }, 'TAKEN'), (e) => e.code === 'E_DUP');
});

test('acceptance 3: after batch delete, old proof still proves, new query excludes', () => {
  const s = new Store();
  s.loadBatch({ batchId: 'B1', docs: DOCS.filter((d) => d.batchId === 'B1') });
  s.loadBatch({ batchId: 'B2', docs: DOCS.filter((d) => d.batchId === 'B2') });
  const { rec } = s.recall({ phrase: '裂', batchCode: 'CRK01' }, 'RC');
  assert.ok(rec.hits.includes('D05')); // D05 batchCode CRK01
  const proofBefore = s.prove('RC');
  assert.deepEqual(proofBefore.hits, rec.hits);

  s.deleteBatch('B2');

  // old proof still verifies and still shows the historical hits
  const proofAfter = s.prove('RC');
  assert.deepEqual(proofAfter.hits, rec.hits);
  assert.equal(proofAfter.epoch, rec.epoch);
  assert.equal(proofAfter.revoked, false);

  // new recall with the same query: new epoch, deleted docs excluded
  const r2 = s.recall({ phrase: '裂', batchCode: 'CRK01' });
  assert.equal(r2.created, true);
  assert.ok(r2.rec.epoch > rec.epoch);
  assert.ok(!r2.rec.hits.some((id) => ['D04', 'D05', 'D06'].includes(id)));
  assert.deepEqual(r2.rec.hits, rec.hits.filter((id) => !['D04', 'D05', 'D06'].includes(id)));
  // audit chain still valid after deletion
  assert.equal(s.verifyAudit().ok, true);
});

test('acceptance 4: revoke restores epoch, audit keeps causal chain, history cannot be rewritten', () => {
  const s = new Store();
  s.loadBatch({ batchId: 'B1', docs: DOCS.filter((d) => d.batchId === 'B1') });
  s.loadBatch({ batchId: 'B2', docs: DOCS.filter((d) => d.batchId === 'B2') });
  const r1 = s.recall({ phrase: '裂纹 扩展' }, 'R-A');
  const r2 = s.recall({ defectCode: 'LEA01' }, 'R-B');
  const epochBeforeRevoke = s.epoch;

  // cannot revoke R-A: a later recall moved the epoch on
  assert.throws(() => s.revoke('R-A'), (e) => e.code === 'E_EPOCH');
  assert.equal(s.epoch, epochBeforeRevoke);

  // revoke the most recent recall: epoch restored, history preserved
  const rv = s.revoke('R-B');
  assert.equal(rv.restoredEpoch, r2.rec.preEpoch);
  assert.equal(s.epoch, r2.rec.preEpoch);
  assert.throws(() => s.revoke('R-B'), (e) => e.code === 'E_DUP');

  // audit shows the causal chain LOAD,LOAD,RECALL,RECALL,REVOKE with hash links
  const report = s.auditReport();
  assert.equal(report.ok, true);
  assert.deepEqual(report.entries.map((e) => e.type), ['LOAD', 'LOAD', 'RECALL', 'RECALL', 'REVOKE']);
  for (let i = 1; i < report.entries.length; i++) {
    assert.equal(report.entries[i].prevHash, report.entries[i - 1].hash);
  }
  const revokeEntry = report.entries.at(-1);
  const recallEntry = report.entries.find((e) => e.type === 'RECALL' && e.payload.recallId === 'R-B');
  assert.equal(revokeEntry.payload.recallHash, recallEntry.hash); // causal link

  // proof of revoked recall: still provable (happened), marked revoked
  const proof = s.prove('R-B');
  assert.equal(proof.revoked, true);
  assert.ok(proof.revokeHash);

  // epoch restored -> R-A is now the latest op and can be revoked too
  s.revoke('R-A');
  assert.equal(s.epoch, r1.rec.preEpoch);

  // --- tampering: rewriting history so the recall "never happened" is detected
  const json = s.toJSON();
  // attacker drops the RECALL+REVOKE entries for R-B
  const tampered = JSON.parse(JSON.stringify(json));
  tampered.audit = tampered.audit.filter(
    (e) => !(e.payload && e.payload.recallId === 'R-B'));
  const s2 = Store.fromJSON(tampered);
  assert.equal(s2.verifyAudit().ok, false);
  assert.throws(() => s2.prove('R-B'), (e) => e.code === 'E_PROOF');
  // attacker only drops the REVOKE entry (pretend never revoked)
  const tampered2 = JSON.parse(JSON.stringify(json));
  tampered2.audit = tampered2.audit.filter((e) => e.type !== 'REVOKE');
  const s3 = Store.fromJSON(tampered2);
  assert.throws(() => s3.prove('R-B'), (e) => e.code === 'E_PROOF');
  // attacker edits hits of a stored recall
  const tampered3 = JSON.parse(JSON.stringify(json));
  tampered3.recalls.find((r) => r.id === 'R-B').hits = ['D01'];
  const s4 = Store.fromJSON(tampered3);
  assert.throws(() => s4.prove('R-B'), (e) => e.code === 'E_PROOF');
});

test('errors: E_DUP on duplicate batch, E_EPOCH on unknown batch delete', () => {
  const s = new Store();
  const batch = { batchId: 'B1', docs: [{ id: 'X1', description: '漏', defectCode: 'A1', batchCode: 'B1' }] };
  s.loadBatch(batch);
  assert.throws(() => s.loadBatch(batch), (e) => e.code === 'E_DUP');
  assert.throws(() => s.deleteBatch('NOPE'), (e) => e.code === 'E_EPOCH');
  assert.throws(() => s.prove('NOPE'), (e) => e.code === 'E_PROOF');
  assert.throws(() => s.revoke('NOPE'), (e) => e.code === 'E_EPOCH');
});

test('store survives JSON persistence roundtrip', () => {
  const s = new Store();
  s.loadBatch({ batchId: 'B1', docs: DOCS });
  s.recall({ phrase: '裂纹 扩展' }, 'R1');
  s.deleteBatch('B1');
  const restored = Store.fromJSON(JSON.parse(JSON.stringify(s.toJSON())));
  assert.equal(restored.epoch, s.epoch);
  assert.equal(restored.verifyAudit().ok, true);
  assert.deepEqual(restored.prove('R1').hits, s.prove('R1').hits);
  const q = normalizeQuery({ phrase: '裂' });
  assert.deepEqual(restored.index.search(q).toArray(), restored.index.bruteForce(q).toArray());
});
