import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  GENESIS_HASH,
  payloadCapacity,
  encodePage,
  decodePage,
  validatePage,
  pageHash,
  encodeCommit,
  validateCommit,
  COMMIT_SIZE,
} from '../src/page.js';

const PAGE_SIZE = 256;

function makePage(overrides = {}) {
  return encodePage({
    pageIndex: 0,
    firstSeq: 1,
    eventCount: 1,
    payload: Buffer.from('{"seq":1,"tenant":"a"}\n'),
    prevHash: GENESIS_HASH,
    pageSize: PAGE_SIZE,
    ...overrides,
  });
}

test('page encode/decode roundtrip', () => {
  const buf = makePage();
  assert.equal(buf.length, PAGE_SIZE);
  const page = decodePage(buf);
  assert.equal(page.pageSize, PAGE_SIZE);
  assert.equal(page.pageIndex, 0);
  assert.equal(page.firstSeq, 1);
  assert.equal(page.eventCount, 1);
  assert.equal(page.payload.toString(), '{"seq":1,"tenant":"a"}\n');
  assert.deepEqual(page.prevHash, GENESIS_HASH);
});

test('validatePage accepts a well-formed page', () => {
  const buf = makePage();
  assert.equal(validatePage(buf, { expectedIndex: 0, expectedPrevHash: GENESIS_HASH, expectedFirstSeq: 1 }), null);
});

test('validatePage rejects tampering', () => {
  const good = makePage();
  const expect = { expectedIndex: 0, expectedPrevHash: GENESIS_HASH, expectedFirstSeq: 1 };

  const badMagic = Buffer.from(good);
  badMagic[0] ^= 0xff;
  assert.equal(validatePage(badMagic, expect).code, 'CORRUPT');

  const badIndex = Buffer.from(good);
  badIndex[23] ^= 0x01;
  assert.equal(validatePage(badIndex, expect).code, 'CORRUPT');

  const badPayload = Buffer.from(good);
  badPayload[80] ^= 0x01;
  assert.equal(validatePage(badPayload, expect).code, 'CORRUPT');

  const badSeq = makePage({ firstSeq: 7 });
  assert.equal(validatePage(badSeq, expect).code, 'SEQ_GAP');

  const badChain = makePage({ pageIndex: 1, prevHash: Buffer.alloc(32, 9) });
  assert.equal(
    validatePage(badChain, { expectedIndex: 1, expectedPrevHash: GENESIS_HASH, expectedFirstSeq: 1 }).code,
    'CORRUPT',
  );
});

test('commit record validates the full page hash', () => {
  const page = makePage();
  const commit = encodeCommit({ pageIndex: 0, hash: pageHash(page) });
  assert.equal(commit.length, COMMIT_SIZE);
  assert.equal(validateCommit(commit, 0, pageHash(page)), null);

  const tampered = Buffer.from(page);
  tampered[200] ^= 0x01; // padding byte: commit record still catches it
  assert.equal(validateCommit(commit, 0, pageHash(tampered)).code, 'CORRUPT');

  const badCommit = Buffer.from(commit);
  badCommit[0] ^= 0xff;
  assert.equal(validateCommit(badCommit, 0, pageHash(page)).code, 'CORRUPT');
});

test('hash chain links pages', () => {
  const p0 = makePage();
  const p1 = makePage({ pageIndex: 1, firstSeq: 2, prevHash: pageHash(p0) });
  assert.equal(
    validatePage(p1, { expectedIndex: 1, expectedPrevHash: pageHash(p0), expectedFirstSeq: 2 }),
    null,
  );
  assert.notEqual(pageHash(p0).toString('hex'), pageHash(p1).toString('hex'));
  assert.ok(payloadCapacity(PAGE_SIZE) > 0);
});
