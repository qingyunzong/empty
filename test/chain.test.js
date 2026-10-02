import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { CustodyChain } from '../src/chain.js';
import { CODES } from '../src/errors.js';
import { tmpStore, readLines, writeLines, cleanup } from '../support/helpers.js';

test('revoke keeps history verifiable, marks old events restricted, rejects new use', () => {
  const dir = tmpStore();
  try {
    const chain = CustodyChain.open(dir);
    chain.appendEvent({ type: 'receive', actor: 'alice', sampleId: 'S1', consentId: 'C1' });
    chain.appendEvent({ type: 'transfer', actor: 'bob', sampleId: 'S1', consentId: 'C1' });
    chain.appendEvent({ type: 'receive', actor: 'alice', sampleId: 'S2', consentId: 'C2' });

    let v = chain.verify();
    assert.equal(v.ok, true);
    assert.deepEqual(v.restricted, []);

    chain.appendEvent({ type: 'revoke', actor: 'bob', consentId: 'C1', reason: 'donor withdrew' });

    // History still verifies after revocation.
    v = chain.verify();
    assert.equal(v.ok, true);
    assert.equal(v.eventCount, 4);
    assert.deepEqual(v.restricted, [0, 1]);

    // New event depending on revoked consent is rejected.
    assert.throws(
      () => chain.appendEvent({ type: 'analyze', actor: 'lab', sampleId: 'S1', consentId: 'C1' }),
      (err) => err.code === CODES.REVOKED_CONSENT && err.details.consentId === 'C1',
    );
    // Unrelated consent still works.
    chain.appendEvent({ type: 'analyze', actor: 'lab', sampleId: 'S2', consentId: 'C2' });

    // After reopen, revocation persists and old facts are intact.
    const reopened = CustodyChain.open(dir);
    const v2 = reopened.verify();
    assert.equal(v2.ok, true);
    assert.equal(v2.eventCount, 5);
    assert.deepEqual(v2.restricted, [0, 1]);
    assert.throws(
      () => reopened.appendEvent({ type: 'destroy', actor: 'lab', sampleId: 'S1', consentId: 'C1' }),
      (err) => err.code === CODES.REVOKED_CONSENT,
    );
  } finally {
    cleanup(dir);
  }
});

test('tampering with any event breaks verification and locates the event', () => {
  const dir = tmpStore();
  try {
    const chain = CustodyChain.open(dir);
    for (let i = 0; i < 6; i++) {
      chain.appendEvent({ type: 'transfer', actor: 'a', sampleId: 'S' + i, consentId: 'C' + i });
    }

    const original = readLines(dir);
    for (const target of [0, 3, 5]) {
      const lines = original.slice();
      const ev = JSON.parse(lines[target]);
      ev.actor = 'mallory';
      lines[target] = JSON.stringify(ev);
      writeLines(dir, lines);
      assert.throws(
        () => CustodyChain.open(dir),
        (err) => err.code === CODES.BROKEN_CHAIN && err.details.seq === target,
      );
    }

    // Tampering with prevHash linkage is also located.
    const lines = original.slice();
    const ev = JSON.parse(lines[2]);
    ev.prevHash = 'f'.repeat(64);
    lines[2] = JSON.stringify(ev);
    writeLines(dir, lines);
    assert.throws(
      () => CustodyChain.open(dir),
      (err) => err.code === CODES.BROKEN_CHAIN && err.details.seq === 2,
    );
  } finally {
    cleanup(dir);
  }
});

test('deleting an event from the middle breaks the chain', () => {
  const dir = tmpStore();
  try {
    const chain = CustodyChain.open(dir);
    for (let i = 0; i < 4; i++) {
      chain.appendEvent({ type: 'receive', actor: 'a', sampleId: 'S' + i, consentId: 'C' + i });
    }
    const lines = readLines(dir);
    lines.splice(1, 1);
    writeLines(dir, lines);
    assert.throws(
      () => CustodyChain.open(dir),
      (err) => err.code === CODES.BROKEN_CHAIN,
    );
  } finally {
    cleanup(dir);
  }
});

test('revoke requires a reason and unknown types are rejected', () => {
  const dir = tmpStore();
  try {
    const chain = CustodyChain.open(dir);
    assert.throws(
      () => chain.appendEvent({ type: 'revoke', actor: 'a', consentId: 'C1' }),
      (err) => err.code === CODES.INVALID_EVENT,
    );
    assert.throws(
      () => chain.appendEvent({ type: 'teleport', actor: 'a', consentId: 'C1' }),
      (err) => err.code === CODES.INVALID_EVENT,
    );
    assert.throws(
      () => chain.appendEvent({ type: 'receive', actor: 'a' }),
      (err) => err.code === CODES.INVALID_EVENT,
    );
  } finally {
    cleanup(dir);
  }
});
