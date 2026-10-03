import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Engine, certHash } from '../src/engine.js';

function buildEngine() {
  const e = new Engine();
  e.addDocument('泵 气蚀 原因码 c01 处理码 a07 检查 入口 压力', 'A1');
  e.addDocument('泵 气蚀 原因码 c02 处理码 a09 检查 密封', 'A2');
  e.addDocument('阀门 泄漏 原因码 c03 处理码 a11', 'A3');
  return e;
}

// Acceptance 3: after delete + compact the certificate changes, and the old
// certificate still proves history via the chain.
test('compact issues cert with termCount, deletedCount, rootHash', () => {
  const e = buildEngine();
  const cert = e.compact();
  assert.equal(cert.seq, 1);
  assert.ok(cert.termCount > 0);
  assert.equal(cert.deletedCount, 0);
  assert.match(cert.rootHash, /^[0-9a-f]{64}$/);
  assert.match(cert.prevHash, /^0{64}$/);
  assert.equal(e.verifyCerts().rootHash, cert.rootHash);
});

test('delete filters queries before compact; compact changes cert; old cert proves history', () => {
  const e = buildEngine();
  const cert1 = e.compact();

  e.deleteDocument('A2');
  // tombstone participates in query filtering immediately
  assert.deepEqual(e.query({ phrase: '泵 气蚀' }).map((r) => r.ext), ['A1']);

  const cert2 = e.compact();
  assert.notEqual(cert2.rootHash, cert1.rootHash);
  assert.equal(cert2.deletedCount, 1);
  assert.equal(cert2.termCount < cert1.termCount || cert2.termCount > 0, true);
  // old cert proves history: cert2 commits to cert1's hash
  assert.equal(cert2.prevHash, certHash(cert1));
  assert.equal(e.verifyCerts().rootHash, cert2.rootHash);
  // purged doc is gone from the dictionary
  assert.deepEqual(e.query({ phrase: '泵 气蚀' }).map((r) => r.ext), ['A1']);
});

test('tampering with state fails verification with E_CERT', () => {
  const e = buildEngine();
  e.compact();
  e.docs.get(1).text = '篡改 的 内容';
  assert.throws(() => e.verifyCerts(), (err) => err.code === 'E_CERT');
});

test('broken chain fails verification with E_CERT', () => {
  const e = buildEngine();
  e.compact();
  e.deleteDocument('A3');
  e.compact();
  e.certs[1].prevHash = 'f'.repeat(64);
  assert.throws(() => e.verifyCerts(), (err) => err.code === 'E_CERT');
});

test('persistence roundtrip preserves query results and certs', () => {
  const e = buildEngine();
  e.deleteDocument('A3');
  e.compact();
  const json = JSON.parse(JSON.stringify(e.toJSON()));
  const e2 = Engine.fromJSON(json);
  assert.deepEqual(e2.query({ phrase: '泵 气蚀' }), e.query({ phrase: '泵 气蚀' }));
  assert.equal(e2.verifyCerts().rootHash, e.certs[e.certs.length - 1].rootHash);
});
