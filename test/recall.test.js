'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { Store, tokenize, normalizeQuery } = require('../src/store');
const { Bitmap } = require('../src/bitmap');
const { hashHitIds } = require('../src/hash');
const { RecallError, E_EPOCH, E_DUP, E_PROOF } = require('../src/errors');

const DOCS = [
  { desc: '齿轮表面裂纹 扩展明显，需召回', code: '裂纹', batch: '扩展' },
  { desc: '轴承出现裂纹但未扩展', code: 'D1', batch: 'B1' },
  { desc: '正常件，无缺陷', code: 'D2', batch: 'B2' },
  { desc: '壳体裂纹 扩展至边缘', code: 'D3', batch: 'B3' },
  { desc: '涂层剥落', code: 'D4', batch: 'B4' },
];

// Brute-force reference: ordered near-phrase in desc (t2 starts within
// `window` chars after t1 ends), or code==t1 && batch==t2 near-neighbor.
function bruteForce(docs, norm) {
  const [t1, t2] = norm.phrase;
  const hits = [];
  docs.forEach((doc, i) => {
    const id = i + 1;
    let phraseHit = false;
    for (let p = doc.desc.indexOf(t1); p !== -1 && !phraseHit; p = doc.desc.indexOf(t1, p + 1)) {
      for (let q = doc.desc.indexOf(t2); q !== -1; q = doc.desc.indexOf(t2, q + 1)) {
        const gap = q - (p + t1.length);
        if (gap >= 0 && gap <= norm.window) {
          phraseHit = true;
          break;
        }
      }
    }
    const nearHit = doc.code === t1 && doc.batch === t2;
    if (phraseHit || nearHit) hits.push(id);
  });
  return hits;
}

function allQueries() {
  const terms = new Set();
  for (const d of DOCS) {
    for (const t of tokenize(d.desc)) terms.add(t.term);
    terms.add(d.code);
    terms.add(d.batch);
  }
  const list = [...terms];
  const queries = [];
  for (const a of list) for (const b of list) queries.push({ phrase: [a, b] });
  queries.push({ phrase: ['不存在', '词'] });
  return queries;
}

test('acceptance 1: enumerate all queries, index recall set == brute force', () => {
  const store = new Store();
  store.load(DOCS);
  const queries = allQueries();
  assert.ok(queries.length > 400, 'query space should be non-trivial');
  for (const q of queries) {
    const norm = normalizeQuery(q);
    const { hits } = store.evaluate(norm);
    const expected = bruteForce(DOCS, norm);
    assert.deepEqual(hits.toArray(), expected, `mismatch for phrase ${JSON.stringify(norm.phrase)}`);
  }
});

test('acceptance 2: repeated recall with same text/conditions is idempotent, epoch unchanged', () => {
  const store = new Store();
  store.load(DOCS);
  const epochBefore = store.epoch;
  const ledgerBefore = store.ledger.length;
  const q = { phrase: ['裂纹', '扩展'] };
  const c1 = store.recall(q);
  const c2 = store.recall(q);
  assert.equal(c1.deduped, false);
  assert.equal(c2.deduped, true);
  assert.equal(c1.hash, c2.hash);
  assert.equal(store.epoch, c1.epoch);
  assert.equal(store.epoch, epochBefore, 'recall does not bump epoch');
  assert.equal(store.ledger.length, ledgerBefore + 1, 'deduped recall adds no ledger entry');
  assert.throws(() => store.recall(q, { force: true }), (e) => e instanceof RecallError && e.code === E_DUP);
});

test('acceptance 3: after batch deletion, old proof still verifies historically; new query excludes', () => {
  const store = new Store();
  store.load(DOCS);
  const q = { phrase: ['裂纹', '扩展'] };
  const cert = store.recall(q);
  assert.ok(cert.hitIds.includes(1) && cert.hitIds.includes(4));

  // Doc 4 is in batch B3; delete it.
  store.deleteBatch('B3');
  assert.notEqual(store.epoch, cert.epoch);

  // Old certificate verifies against its own epoch (historical inclusion).
  const oldProof = store.prove(cert, { atEpoch: cert.epoch });
  assert.equal(oldProof.ok, true);
  assert.equal(oldProof.historical, true);

  // Same certificate against the live state raises E_EPOCH.
  assert.throws(() => store.prove(cert), (e) => e.code === E_EPOCH);

  // New recall at the new epoch excludes the deleted doc.
  const cert2 = store.recall(q);
  assert.equal(cert2.epoch, store.epoch);
  assert.ok(!cert2.hitIds.includes(4));
  assert.ok(cert2.hitIds.includes(1));
  assert.deepEqual(store.evaluate(q).hits.toArray(), cert2.hitIds);

  // Unknown batch deletion is rejected.
  assert.throws(() => store.deleteBatch('NOPE'), (e) => e.code === E_EPOCH);
});

test('acceptance 4: revoke restores epoch assertion but audit keeps the causal chain', () => {
  const store = new Store();
  store.load(DOCS);
  const q = { phrase: ['裂纹', '扩展'] };
  const cert = store.recall(q);
  const ledgerBeforeRevoke = store.ledger.length;

  const rev = store.revoke(q);
  assert.equal(rev.revokedCertHash, cert.hash);

  const audit = store.audit();
  assert.equal(audit.valid, true, 'hash chain intact');
  assert.equal(audit.length, ledgerBeforeRevoke + 1);

  const recallEntry = audit.entries.find((e) => e.type === 'recall' && e.data.certHash === cert.hash);
  const revokeEntry = audit.entries.find((e) => e.type === 'revoke');
  assert.ok(recallEntry, 'original recall entry still present (history not falsified)');
  assert.ok(revokeEntry, 'revoke entry present');
  assert.equal(revokeEntry.data.revokedCertHash, cert.hash);
  assert.equal(revokeEntry.data.recallLedgerSeq, recallEntry.seq, 'revoke points at its cause');
  assert.ok(revokeEntry.seq > recallEntry.seq, 'causal order preserved');

  // The recall record is marked revoked, not erased.
  const rec = audit.recalls.find((r) => r.certHash === cert.hash);
  assert.equal(rec.revoked, true);

  // Double revoke rejected; revoking an unknown recall rejected.
  assert.throws(() => store.revoke(q), (e) => e.code === E_DUP);
  assert.throws(() => store.revoke({ phrase: ['从', '未'] }), (e) => e.code === E_PROOF);

  // Proof of the revoked certificate reports its revoked status honestly.
  const proof = store.prove(cert, { atEpoch: cert.epoch });
  assert.equal(proof.revoked, true);

  // Re-issuing after revoke creates a new version; both stay in the chain.
  const cert2 = store.recall(q);
  assert.equal(cert2.deduped, false);
  const audit2 = store.audit();
  assert.equal(audit2.recalls.filter((r) => r.epoch === cert.epoch).length, 2);
  assert.equal(audit2.valid, true);
});

test('proof errors: tampered certificates raise E_PROOF', () => {
  const store = new Store();
  store.load(DOCS);
  const cert = store.recall({ phrase: ['裂纹', '扩展'] });

  const tamperedHits = { ...cert, hitIds: [...cert.hitIds, 999] };
  assert.throws(() => store.prove(tamperedHits, { atEpoch: cert.epoch }), (e) => e.code === E_PROOF);

  const tamperedQuery = { ...cert, query: { phrase: ['壳体', '扩展'], window: 4 } };
  assert.throws(() => store.prove(tamperedQuery, { atEpoch: cert.epoch }), (e) => e.code === E_PROOF);

  const wrongEpoch = { ...cert, epoch: 99 };
  assert.throws(() => store.prove(wrongEpoch, { atEpoch: 99 }), (e) => e.code === E_EPOCH);
});

test('bitmap: roaring-style containers round-trip and stay sorted', () => {
  const bm = new Bitmap();
  const ids = [1, 2, 3, 70000, 65536, 131071, 42, 5];
  for (const id of ids) bm.add(id);
  assert.deepEqual(bm.toArray(), [...ids].sort((a, b) => a - b));
  bm.delete(70000);
  bm.delete(1);
  assert.deepEqual(bm.toArray(), [2, 3, 5, 42, 65536, 131071]);
  assert.equal(bm.has(42), true);
  assert.equal(bm.has(43), false);

  // Dense container flips to bitset and back.
  const dense = new Bitmap();
  for (let i = 0; i < 5000; i++) dense.add(i);
  assert.equal(dense.size, 5000);
  for (let i = 0; i < 4900; i++) dense.delete(i);
  assert.deepEqual(dense.toArray(), Array.from({ length: 100 }, (_, i) => i + 4900));

  const restored = Bitmap.deserialize(JSON.parse(JSON.stringify(dense.serialize())));
  assert.deepEqual(restored.toArray(), dense.toArray());
});

test('certificate binds sorted hit ids + query norm hash + epoch', () => {
  const store = new Store();
  store.load(DOCS);
  const cert = store.recall({ phrase: ['裂纹', '扩展'] });
  const sorted = [...cert.hitIds].sort((a, b) => a - b);
  assert.deepEqual(cert.hitIds, sorted);
  assert.equal(cert.hitsHash, hashHitIds(sorted));
  assert.equal(typeof cert.queryHash, 'string');
  assert.equal(cert.epoch, store.epoch);
  assert.equal(cert.stateHash, store.epochStates.get(store.epoch));
});

test('persistence: serialize/deserialize preserves index, ledger and recalls', () => {
  const store = new Store();
  store.load(DOCS);
  const cert = store.recall({ phrase: ['裂纹', '扩展'] });
  store.deleteBatch('B3');
  const copy = Store.deserialize(JSON.parse(JSON.stringify(store.serialize())));
  assert.equal(copy.epoch, store.epoch);
  assert.equal(copy.audit().valid, true);
  assert.deepEqual(copy.evaluate({ phrase: ['裂纹', '扩展'] }).hits.toArray(), [1, 2]);
  const proof = copy.prove(cert, { atEpoch: cert.epoch });
  assert.equal(proof.ok, true);
});
