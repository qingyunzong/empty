import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { GuaranteeChain, GuaranteeError, STATE } from '../src/guarantee-chain.js';

const FAR_FUTURE = '2030-01-01T00:00:00Z';
const PAST = '2020-01-01T00:00:00Z';
const NOW = '2026-01-01T00:00:00Z';

function makeDir() {
  return mkdtempSync(join(tmpdir(), 'guarantee-chain-'));
}

function expectedUsed(chain) {
  const used = new Map(chain.list().map((g) => [g.id, 0]));
  for (const g of chain.list()) {
    if (g.state !== STATE.ACTIVE) continue;
    let parentId = g.parentId;
    while (parentId) {
      used.set(parentId, used.get(parentId) + g.exposure);
      parentId = chain.get(parentId).parentId;
    }
  }
  return used;
}

function assertConsistentWithTreeWalk(chain) {
  const used = expectedUsed(chain);
  for (const g of chain.list()) {
    assert.equal(g.used, used.get(g.id), `frozen used of ${g.id}`);
    assert.ok(g.used <= g.cap, `cap of ${g.id}`);
    assert.equal(chain.remaining(g.id), g.cap - used.get(g.id), `remaining of ${g.id}`);
  }
  const report = chain.verify();
  assert.ok(report.ok, report.problems.join('; '));
}

function buildMultiBranch(chain) {
  chain.issue({ id: 'R', exposure: 100, cap: 1000, terms: 'master standby letter of credit', expiresAt: FAR_FUTURE });
  chain.issue({ id: 'A', parentId: 'R', exposure: 200, cap: 500, terms: 'branch alpha payment guarantee', expiresAt: FAR_FUTURE });
  chain.issue({ id: 'B', parentId: 'R', exposure: 150, cap: 300, terms: 'branch beta performance bond', expiresAt: PAST });
  chain.issue({ id: 'A1', parentId: 'A', exposure: 120, cap: 200, terms: 'alpha one advance payment', expiresAt: FAR_FUTURE });
  chain.issue({ id: 'A2', parentId: 'A', exposure: 60, cap: 100, terms: 'alpha two warranty', expiresAt: PAST });
  chain.issue({ id: 'B1', parentId: 'B', exposure: 90, cap: 100, terms: 'beta one customs duty', expiresAt: PAST });
  chain.issue({ id: 'A1a', parentId: 'A1', exposure: 40, cap: 50, terms: 'alpha one sub retention money', expiresAt: FAR_FUTURE });
}

test('multi-branch issue/revoke/expire matches independent tree-walk sums', () => {
  const chain = new GuaranteeChain({ dataDir: makeDir() });
  buildMultiBranch(chain);
  assertConsistentWithTreeWalk(chain);

  assert.equal(chain.get('R').used, 660);
  assert.equal(chain.get('A').used, 220);
  assert.equal(chain.get('A1').used, 40);

  chain.revoke('A2');
  assert.equal(chain.get('A2').state, STATE.REVOKED);
  assert.equal(chain.get('A').used, 160);
  assert.equal(chain.get('R').used, 600);
  assertConsistentWithTreeWalk(chain);

  chain.expire('B', NOW);
  assert.equal(chain.get('B').state, STATE.EXPIRED);
  assert.equal(chain.get('R').used, 450);
  assert.equal(chain.get('B').used, 90, 'live child B1 keeps its occupation in B');
  assertConsistentWithTreeWalk(chain);

  chain.revoke('B1');
  assert.equal(chain.get('B').used, 0);
  assert.equal(chain.get('R').used, 360);
  assertConsistentWithTreeWalk(chain);

  chain.revoke('A1a');
  chain.revoke('A1');
  assert.equal(chain.get('A').used, 0);
  assert.equal(chain.get('R').used, 200);
  assertConsistentWithTreeWalk(chain);
});

test('purge removes leaf guarantees and compacts the terms index', () => {
  const chain = new GuaranteeChain({ dataDir: makeDir() });
  buildMultiBranch(chain);
  chain.revoke('A2');
  chain.expire('B', NOW);
  chain.revoke('B1');

  assert.equal(chain.indexStats().docs, 7);
  assert.deepEqual(chain.postingsOf('warranty'), { A2: [2] });

  chain.purge('A2', NOW);
  assert.equal(chain.get('A2'), undefined);
  assert.deepEqual(chain.postingsOf('warranty'), {});
  assert.equal(chain.indexStats().docs, 6);

  chain.purge('B1', NOW);
  assert.deepEqual(chain.postingsOf('customs'), {});
  chain.purge('B', NOW);
  assert.equal(chain.get('B'), undefined);
  assert.deepEqual(chain.postingsOf('beta'), {});
  assertConsistentWithTreeWalk(chain);
});

test('audit certificate exposes occupation path, remaining capacity, hits and chain hash', () => {
  const chain = new GuaranteeChain({ dataDir: makeDir() });
  buildMultiBranch(chain);
  chain.revoke('A2');

  const cert = chain.audit('A1a', { phrase: 'retention money' });
  assert.deepEqual(cert.path.map((l) => l.id), ['R', 'A', 'A1', 'A1a']);
  assert.deepEqual(cert.path.map((l) => l.remaining), [400, 340, 160, 50]);
  assert.deepEqual(cert.hits.phrase, [3]);
  assert.equal(cert.chainHash, chain.get('A1a').chainHash);
  assert.ok(cert.verified);

  const nearCert = chain.audit('A1', { near: { terms: ['advance', 'payment'], k: 2 } });
  assert.deepEqual(nearCert.hits.near, [[2, 3]]);

  const rootCert = chain.audit('R');
  assert.equal(rootCert.path.length, 1);
  assert.equal(rootCert.hits, null);
  assert.ok(rootCert.verified);
});

test('failures raise coded errors and leave no partial writes', () => {
  const dataDir = makeDir();
  const chain = new GuaranteeChain({ dataDir });
  chain.issue({ id: 'R', exposure: 10, cap: 100, terms: 'root', expiresAt: FAR_FUTURE });
  chain.issue({ id: 'A', parentId: 'R', exposure: 30, cap: 40, terms: 'child', expiresAt: FAR_FUTURE });

  const expectFailure = (code, fn) => {
    const snapshotBefore = chain.snapshot();
    const fileBefore = readFileSync(chain.stateFile);
    assert.throws(fn, (err) => err instanceof GuaranteeError && err.code === code);
    assert.equal(chain.snapshot(), snapshotBefore, `state changed after ${code}`);
    assert.deepEqual(readFileSync(chain.stateFile), fileBefore, `file changed after ${code}`);
  };

  expectFailure('OVER_CAP', () => chain.issue({ id: 'X', parentId: 'R', exposure: 95, cap: 10, expiresAt: FAR_FUTURE }));
  expectFailure('OVER_CAP', () => chain.issue({ id: 'Y', parentId: 'A', exposure: 50, cap: 5, expiresAt: FAR_FUTURE }));
  expectFailure('PARENT_NOT_FOUND', () => chain.issue({ id: 'Z', parentId: 'NOPE', exposure: 1, cap: 1, expiresAt: FAR_FUTURE }));
  expectFailure('DUPLICATE_ID', () => chain.issue({ id: 'A', exposure: 1, cap: 1, expiresAt: FAR_FUTURE }));

  chain.revoke('A');
  expectFailure('INVALID_STATE', () => chain.revoke('A'));
  expectFailure('INVALID_STATE', () => chain.expire('A', NOW));
  expectFailure('NOT_FOUND', () => chain.revoke('GHOST'));

  chain.issue({ id: 'C', parentId: 'R', exposure: 5, cap: 5, terms: 'grand', expiresAt: FAR_FUTURE });
  chain.expire('R', '2031-01-01T00:00:00Z');
  expectFailure('HAS_LIVE_CHILDREN', () => chain.purge('R', '2031-01-01T00:00:00Z'));
  expectFailure('STILL_ACTIVE', () => chain.purge('C', '2031-01-01T00:00:00Z'));
  expectFailure('NOT_EXPIRED', () => chain.expire('C', NOW));
  expectFailure('NOT_EXPIRED', () => chain.purge('A', NOW));

  assertConsistentWithTreeWalk(chain);
});

test('state survives restart and verifies after reload', () => {
  const dataDir = makeDir();
  const chain = new GuaranteeChain({ dataDir });
  buildMultiBranch(chain);
  chain.revoke('A2');
  chain.expire('B', NOW);
  chain.revoke('B1');
  chain.purge('B1', NOW);
  chain.purge('A2', NOW);

  const reloaded = GuaranteeChain.load({ dataDir });
  assert.equal(reloaded.snapshot(), chain.snapshot());
  assert.ok(reloaded.verify().ok);
  assert.deepEqual(reloaded.queryPhrase('advance payment'), { A1: [2] });
  assert.deepEqual(reloaded.queryNear('standby', 'credit', 3), { R: [[1, 4]] });
  assert.equal(reloaded.audit('A1a').chainHash, chain.audit('A1a').chainHash);
  assertConsistentWithTreeWalk(reloaded);
});

test('corrupted state file is rejected on load', () => {
  const dataDir = makeDir();
  const chain = new GuaranteeChain({ dataDir });
  chain.issue({ id: 'R', exposure: 10, cap: 100, terms: 'root', expiresAt: FAR_FUTURE });
  const doc = JSON.parse(readFileSync(chain.stateFile, 'utf8'));
  doc.guarantees[0].used = 999;
  writeFileSync(chain.stateFile, JSON.stringify(doc));
  assert.throws(
    () => GuaranteeChain.load({ dataDir }),
    (err) => err instanceof GuaranteeError && err.code === 'CHECKSUM_MISMATCH',
  );
});
