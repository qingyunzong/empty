import assert from 'node:assert/strict';
import test from 'node:test';
import { Manifest } from '../src/manifest.js';
import { hashArtifact, hashFile, hashRelease } from '../src/hash.js';

function baseManifest() {
  const m = new Manifest();
  const r = m.commit([
    { op: 'putFile', id: 'f-raw', content: 'raw-data' },
    { op: 'putFile', id: 'f-meta', content: 'metadata' },
    { op: 'addArtifact', id: 'a-clean', builder: 'normalize', inputs: ['f-raw'] },
    { op: 'addArtifact', id: 'a-pack', builder: 'concat', inputs: ['a-clean', 'f-meta'] },
    { op: 'addRelease', id: 'r-main', inputs: ['a-pack'] },
  ], 'tx-1');
  assert.equal(r.ok, true);
  return m;
}

test('initial build computes deterministic hashes and certificate', () => {
  const m = baseManifest();
  const fRaw = hashFile('raw-data');
  const fMeta = hashFile('metadata');
  const aClean = hashArtifact('normalize', [{ id: 'f-raw', hash: fRaw }]);
  const aPack = hashArtifact('concat', [{ id: 'a-clean', hash: aClean }, { id: 'f-meta', hash: fMeta }]);
  const rMain = hashRelease([{ id: 'a-pack', hash: aPack }]);
  assert.equal(m.hash('f-raw').hash, fRaw);
  assert.equal(m.hash('a-clean').hash, aClean);
  assert.equal(m.hash('a-pack').hash, aPack);
  assert.equal(m.hash('r-main').hash, rMain);
  const cert = m.certificate();
  assert.equal(cert.tx, 'tx-1');
  assert.equal(cert.artifacts['a-pack'], aPack);
  assert.equal(cert.releases['r-main'].status, 'ok');
  assert.equal(cert.releases['r-main'].hash, rMain);
});

test('same-layer artifacts are recomputed in ascending id order', () => {
  const m = new Manifest();
  const r = m.commit([
    { op: 'putFile', id: 'f0', content: 'x' },
    { op: 'addArtifact', id: 'z-art', builder: 'concat', inputs: ['f0'] },
    { op: 'addArtifact', id: 'b-art', builder: 'concat', inputs: ['f0'] },
    { op: 'addArtifact', id: 'm-art', builder: 'concat', inputs: ['b-art', 'z-art'] },
  ]);
  assert.equal(r.ok, true);
  assert.deepEqual(r.diff.recomputed, ['b-art', 'z-art', 'm-art']);
});

test('deep file correction only invalidates the declared path', () => {
  const m = new Manifest();
  m.commit([
    { op: 'putFile', id: 'f-src', content: 'v1' },
    { op: 'putFile', id: 'f-other', content: 'keep' },
    { op: 'addArtifact', id: 'a1', builder: 'normalize', inputs: ['f-src'] },
    { op: 'addArtifact', id: 'a2', builder: 'concat', inputs: ['a1'] },
    { op: 'addArtifact', id: 'a3', builder: 'aggregate', inputs: ['a2'] },
    { op: 'addArtifact', id: 'b1', builder: 'concat', inputs: ['f-other'] },
    { op: 'addRelease', id: 'r-deep', inputs: ['a3'] },
    { op: 'addRelease', id: 'r-side', inputs: ['b1'] },
  ], 'tx-1');
  const before = m.currentHashes();
  const r = m.commit([{ op: 'putFile', id: 'f-src', content: 'v2' }], 'tx-2');
  assert.equal(r.ok, true);
  assert.deepEqual(r.diff.recomputed, ['a1', 'a2', 'a3']);
  assert.deepEqual(r.diff.changed, ['a1', 'a2', 'a3']);
  assert.deepEqual(r.diff.releasesChanged, ['r-deep']);
  const after = m.currentHashes();
  assert.equal(after['b1'], before['b1']);
  assert.equal(after['r-side'], before['r-side']);
  assert.notEqual(after['a1'], before['a1']);
  assert.notEqual(after['r-deep'], before['r-deep']);
  assert.deepEqual(r.diff.reasons, { a1: 'input-changed:f-src', a2: 'input-changed:a1', a3: 'input-changed:a2' });
});

test('cycle returns E_CYCLE, blocks dependent release, leaves unrelated nodes alone', () => {
  const m = new Manifest();
  m.commit([
    { op: 'putFile', id: 'f0', content: 'x' },
    { op: 'addArtifact', id: 'a', builder: 'concat', inputs: ['f0'] },
    { op: 'addArtifact', id: 'b', builder: 'concat', inputs: ['a'] },
    { op: 'addArtifact', id: 'free', builder: 'concat', inputs: ['f0'] },
    { op: 'addRelease', id: 'r-cyc', inputs: ['b'] },
    { op: 'addRelease', id: 'r-free', inputs: ['free'] },
  ], 'tx-1');
  const r = m.commit([{ op: 'addEdge', from: 'a', to: 'b' }], 'tx-2');
  assert.equal(r.ok, true);
  const cycleError = r.errors.find((e) => e.code === 'E_CYCLE');
  assert.ok(cycleError, 'expected E_CYCLE error');
  assert.deepEqual(cycleError.nodes, ['a', 'b']);
  assert.equal(r.diff.failed.a, 'E_CYCLE');
  assert.equal(r.diff.failed.b, 'E_CYCLE');
  assert.deepEqual(r.blocked['r-cyc'], ['b']);
  assert.equal(r.diff.releases['r-free'].status, 'ok');
  assert.ok(m.hash('free').ok);
  const cert = m.certificate();
  assert.equal(cert.releases['r-cyc'].status, 'blocked');
  assert.equal(cert.releases['r-free'].status, 'ok');
});

test('unknown builder returns E_BUILDER and blocks only dependent releases', () => {
  const m = new Manifest();
  const r = m.commit([
    { op: 'putFile', id: 'f0', content: 'x' },
    { op: 'addArtifact', id: 'bad', builder: 'no-such-builder', inputs: ['f0'] },
    { op: 'addArtifact', id: 'good', builder: 'concat', inputs: ['f0'] },
    { op: 'addRelease', id: 'r-bad', inputs: ['bad'] },
    { op: 'addRelease', id: 'r-good', inputs: ['good'] },
  ]);
  assert.equal(r.ok, true);
  assert.equal(r.diff.failed.bad, 'E_BUILDER');
  assert.ok(r.errors.some((e) => e.code === 'E_BUILDER'));
  assert.deepEqual(r.blocked['r-bad'], ['bad']);
  assert.equal(r.diff.releases['r-good'].status, 'ok');
  assert.equal(m.hash('bad').ok, false);
  assert.equal(m.hash('bad').error.code, 'E_BUILDER');
});

test('failure propagates through dependents without blocking unrelated nodes', () => {
  const m = new Manifest();
  const r = m.commit([
    { op: 'putFile', id: 'f0', content: 'x' },
    { op: 'addArtifact', id: 'bad', builder: 'mystery', inputs: ['f0'] },
    { op: 'addArtifact', id: 'mid', builder: 'concat', inputs: ['bad'] },
    { op: 'addArtifact', id: 'top', builder: 'concat', inputs: ['mid'] },
    { op: 'addArtifact', id: 'side', builder: 'concat', inputs: ['f0'] },
    { op: 'addRelease', id: 'r-top', inputs: ['top'] },
    { op: 'addRelease', id: 'r-side', inputs: ['side'] },
  ]);
  assert.equal(r.ok, true);
  assert.equal(r.diff.failed.bad, 'E_BUILDER');
  assert.equal(r.diff.failed.mid, 'E_INPUT_FAILED');
  assert.equal(r.diff.failed.top, 'E_INPUT_FAILED');
  assert.deepEqual(r.blocked['r-top'], ['top']);
  assert.equal(r.diff.releases['r-side'].status, 'ok');
});

test('rollback restores old hashes and graph structure', () => {
  const m = baseManifest();
  const cert1 = m.certificate();
  const hashBefore = m.hash('a-clean').hash;
  m.commit([
    { op: 'putFile', id: 'f-raw', content: 'corrected' },
    { op: 'addArtifact', id: 'a-extra', builder: 'concat', inputs: ['f-raw'] },
    { op: 'addEdge', from: 'a-pack', to: 'a-extra' },
  ], 'tx-2');
  assert.notEqual(m.hash('a-clean').hash, hashBefore);
  const rb = m.rollback('tx-2');
  assert.equal(rb.ok, true);
  assert.deepEqual(rb.reverted, ['tx-2']);
  assert.equal(m.hash('a-clean').hash, hashBefore);
  assert.equal(m.hash('a-extra').ok, false);
  assert.deepEqual(m.certificate(), cert1);
  const rb2 = m.rollback('tx-1');
  assert.equal(rb2.ok, true);
  assert.deepEqual(m.getState().artifacts, {});
  const rb3 = m.rollback('tx-1');
  assert.equal(rb3.ok, false);
  assert.equal(rb3.error.code, 'E_TX_NOT_FOUND');
});

test('rollback of unknown transaction returns E_TX_NOT_FOUND', () => {
  const m = baseManifest();
  const r = m.rollback('no-such-tx');
  assert.equal(r.ok, false);
  assert.equal(r.error.code, 'E_TX_NOT_FOUND');
});

test('empty transaction returns E_EMPTY_TRANSACTION', () => {
  const m = new Manifest();
  const r = m.commit([]);
  assert.equal(r.ok, false);
  assert.equal(r.error.code, 'E_EMPTY_TRANSACTION');
});

test('duplicate node and unknown input produce clear op errors', () => {
  const m = new Manifest();
  m.commit([{ op: 'putFile', id: 'f0', content: 'x' }], 'tx-1');
  const dup = m.commit([{ op: 'addArtifact', id: 'f0', builder: 'concat', inputs: [] }]);
  assert.equal(dup.ok, false);
  assert.equal(dup.error.code, 'E_DUP');
  const missing = m.commit([{ op: 'addArtifact', id: 'a', builder: 'concat', inputs: ['ghost'] }]);
  assert.equal(missing.ok, false);
  assert.equal(missing.error.code, 'E_NODE');
  const badEdge = m.commit([{ op: 'addEdge', from: 'ghost', to: 'f0' }]);
  assert.equal(badEdge.ok, false);
  assert.equal(badEdge.error.code, 'E_NODE');
});

test('removing an artifact invalidates dependents with E_INPUT', () => {
  const m = new Manifest();
  m.commit([
    { op: 'putFile', id: 'f0', content: 'x' },
    { op: 'addArtifact', id: 'a', builder: 'concat', inputs: ['f0'] },
    { op: 'addArtifact', id: 'b', builder: 'concat', inputs: ['a'] },
    { op: 'addRelease', id: 'r', inputs: ['b'] },
  ], 'tx-1');
  const r = m.commit([{ op: 'removeArtifact', id: 'a' }], 'tx-2');
  assert.equal(r.ok, true);
  assert.deepEqual(r.diff.removed, ['a']);
  assert.equal(r.diff.failed.b, 'E_INPUT');
  assert.deepEqual(r.blocked.r, ['b']);
  const back = m.rollback('tx-2');
  assert.equal(back.ok, true);
  assert.ok(m.hash('a').ok);
  assert.ok(m.hash('b').ok);
  assert.equal(m.certificate().releases.r.status, 'ok');
});

test('certificate is deterministic across identical replays', () => {
  const build = () => {
    const m = new Manifest();
    m.commit([
      { op: 'putFile', id: 'f0', content: 'x' },
      { op: 'addArtifact', id: 'a', builder: 'concat', inputs: ['f0'] },
      { op: 'addRelease', id: 'r', inputs: ['a'] },
    ], 'tx-1');
    return m.certificate();
  };
  assert.deepEqual(build(), build());
});
