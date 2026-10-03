import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Chain } from '../lib/chain.js';
import { verifyProof, merkleProof } from '../lib/merkle.js';

async function freshDir() {
  return mkdtemp(path.join(tmpdir(), 'custody-revoke-'));
}

test('revocation: history verifiable before and after, new use rejected, old events restricted', async (t) => {
  const dir = await freshDir();
  t.after(() => rm(dir, { recursive: true, force: true }));

  const chain = await Chain.open(dir);
  await chain.append({ type: 'receive', sampleId: 'S1', consentId: 'C1' });
  await chain.append({ type: 'transfer', sampleId: 'S1', consentId: 'C1', data: { to: 'lab-A' } });
  await chain.append({ type: 'analyze', sampleId: 'S1', consentId: 'C1', data: { assay: 'pcr' } });

  assert.equal(chain.verify(), true);
  const rootBefore = chain.merkleRoot;
  const headBefore = chain.head;

  const tombstone = await chain.append({ type: 'revoke', consentId: 'C1', data: { reason: 'participant withdrew' } });
  assert.equal(tombstone.type, 'revoke');

  await assert.rejects(
    chain.append({ type: 'analyze', sampleId: 'S1', consentId: 'C1' }),
    (err) => {
      assert.equal(err.code, 'REVOKED_CONSENT');
      return true;
    }
  );

  await assert.rejects(
    chain.append({ type: 'transfer', sampleId: 'S1', consentId: 'C1' }),
    (err) => err.code === 'REVOKED_CONSENT'
  );

  const listed = chain.list();
  assert.equal(listed.length, 4);
  for (const e of listed.slice(0, 3)) {
    assert.equal(e.restricted, true, `old ${e.type} event must be marked restricted`);
  }
  assert.equal(listed[3].restricted, true);

  assert.equal(chain.verify(), true, 'chain with tombstone still verifies');
  assert.equal(chain.events.length, 4, 'old events are retained, not erased');

  const proof = merkleProof(chain.leafHashes(), 1);
  assert.equal(verifyProof(proof), true);
  assert.notEqual(chain.merkleRoot, rootBefore, 'root advances after tombstone append');
  assert.deepEqual(chain.head, { seq: 3, hash: chain.events[3].hash });
  assert.notEqual(chain.head.hash, headBefore.hash);

  const other = await Chain.open(dir);
  await other.append({ type: 'receive', sampleId: 'S2', consentId: 'C2' });
  assert.equal(other.events.length, 5, 'unrelated consents remain usable');
});
