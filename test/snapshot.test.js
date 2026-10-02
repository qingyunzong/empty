import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { CustodyChain } from '../src/chain.js';
import { CODES } from '../src/errors.js';
import { tmpStore, eventsFile, cleanup } from '../support/helpers.js';

function seed(dir, n) {
  const chain = CustodyChain.open(dir);
  for (let i = 0; i < n; i++) {
    chain.appendEvent({ type: 'receive', actor: 'a', sampleId: 'S' + i, consentId: 'C' + i });
  }
  return chain;
}

test('snapshot writes manifest; reopen keeps head consistent with manifest', () => {
  const dir = tmpStore();
  try {
    const chain = seed(dir, 5);
    const manifest = chain.snapshot();
    assert.equal(manifest.seq, 4);
    assert.equal(manifest.leafCount, 5);
    assert.equal(manifest.headHash, chain.head);
    assert.ok(fs.existsSync(path.join(dir, 'manifest.json')));

    const reopened = CustodyChain.open(dir);
    assert.equal(reopened.head, manifest.headHash);
    assert.deepEqual(reopened.manifest, manifest);
    assert.equal(reopened.verify().ok, true);
  } finally {
    cleanup(dir);
  }
});

test('appends after a snapshot keep verifying; manifest covers a prefix', () => {
  const dir = tmpStore();
  try {
    const chain = seed(dir, 3);
    const manifest = chain.snapshot();
    chain.appendEvent({ type: 'transfer', actor: 'b', sampleId: 'S0', consentId: 'C0' });
    chain.appendEvent({ type: 'analyze', actor: 'lab', sampleId: 'S1', consentId: 'C1' });
    const reopened = CustodyChain.open(dir);
    assert.equal(reopened.events.length, 5);
    assert.equal(reopened.manifest.leafCount, 3);
    assert.equal(reopened.manifest.headHash, manifest.headHash);
    assert.equal(reopened.verify().ok, true);
  } finally {
    cleanup(dir);
  }
});

test('crash mid-snapshot (tmp left behind) recovers to old head, no half snapshot', () => {
  const dir = tmpStore();
  try {
    const chain = seed(dir, 4);
    const oldHead = chain.head;
    // Simulate crash between tmp write and rename: partial manifest tmp file.
    fs.writeFileSync(path.join(dir, 'manifest.json.tmp'), '{"version":1,"seq":3,"headHa');
    const recovered = CustodyChain.open(dir);
    assert.equal(recovered.head, oldHead);
    assert.equal(recovered.manifest, null);
    assert.equal(recovered.verify().ok, true);
    // Tmp file cleaned up by recovery.
    assert.equal(fs.existsSync(path.join(dir, 'manifest.json.tmp')), false);
    // A fresh snapshot now succeeds and advances the manifest head.
    const m = recovered.snapshot();
    assert.equal(m.headHash, oldHead);
    assert.equal(CustodyChain.open(dir).manifest.headHash, oldHead);
  } finally {
    cleanup(dir);
  }
});

test('crash mid-snapshot with prior manifest keeps the old manifest head', () => {
  const dir = tmpStore();
  try {
    const chain = seed(dir, 3);
    const m1 = chain.snapshot();
    chain.appendEvent({ type: 'transfer', actor: 'b', sampleId: 'S0', consentId: 'C0' });
    // Crash while publishing the second snapshot.
    fs.writeFileSync(path.join(dir, 'manifest.json.tmp'), '{"version":1,"seq":3');
    const recovered = CustodyChain.open(dir);
    assert.deepEqual(recovered.manifest, m1);
    assert.equal(recovered.events.length, 4);
    assert.equal(recovered.verify().ok, true);
  } finally {
    cleanup(dir);
  }
});

test('torn trailing event line is truncated during recovery', () => {
  const dir = tmpStore();
  try {
    const chain = seed(dir, 3);
    const head = chain.head;
    // Simulate torn append: partial JSON without newline.
    fs.appendFileSync(eventsFile(dir), '{"seq":3,"type":"transfer","actor');
    const recovered = CustodyChain.open(dir);
    assert.equal(recovered.events.length, 3);
    assert.equal(recovered.head, head);
    // Log is writable again after recovery.
    recovered.appendEvent({ type: 'transfer', actor: 'b', sampleId: 'S0', consentId: 'C0' });
    assert.equal(CustodyChain.open(dir).events.length, 4);
  } finally {
    cleanup(dir);
  }
});

test('corrupt manifest.json is detected as BROKEN_CHAIN, never silently half-applied', () => {
  const dir = tmpStore();
  try {
    const chain = seed(dir, 3);
    chain.snapshot();
    fs.writeFileSync(path.join(dir, 'manifest.json'), '{"version":1,"seq":');
    assert.throws(() => CustodyChain.open(dir), (err) => err.code === CODES.BROKEN_CHAIN);
  } finally {
    cleanup(dir);
  }
});

test('manifest inconsistent with log is rejected', () => {
  const dir = tmpStore();
  try {
    const chain = seed(dir, 3);
    const m = chain.snapshot();
    // Manifest claims a head the log does not have.
    fs.writeFileSync(
      path.join(dir, 'manifest.json'),
      JSON.stringify({ ...m, headHash: 'a'.repeat(64) }, null, 2),
    );
    assert.throws(() => CustodyChain.open(dir), (err) => err.code === CODES.BROKEN_CHAIN);
    // Manifest ahead of the log.
    fs.writeFileSync(
      path.join(dir, 'manifest.json'),
      JSON.stringify({ ...m, seq: 9, leafCount: 10 }, null, 2),
    );
    assert.throws(() => CustodyChain.open(dir), (err) => err.code === CODES.BROKEN_CHAIN);
  } finally {
    cleanup(dir);
  }
});

test('snapshot of empty chain gives NO_PROOF', () => {
  const dir = tmpStore();
  try {
    const chain = CustodyChain.open(dir);
    assert.throws(() => chain.snapshot(), (err) => err.code === CODES.NO_PROOF);
  } finally {
    cleanup(dir);
  }
});
