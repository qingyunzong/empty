import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AuditLog } from '../src/log.js';
import { stride } from '../src/page.js';
import { MemStorage } from '../test-helpers/mem-storage.js';

const PAGE_SIZE = 256;
const STRIDE = stride(PAGE_SIZE);
const bigEvent = (tenant, n) => ({ tenant, data: 'y'.repeat(100) + n });

function committedLog(events = [bigEvent('a', 1), bigEvent('a', 2), bigEvent('b', 3)]) {
  const storage = new MemStorage();
  const log = new AuditLog({ storage, pageSize: PAGE_SIZE });
  log.append(events);
  return { storage, log };
}

test('valid log verifies clean', () => {
  const { log } = committedLog();
  const result = log.verify();
  assert.equal(result.valid, true);
  assert.deepEqual(result.violations, []);
  assert.equal(result.stats.pages, 3);
  assert.equal(result.stats.events, 3);
  assert.match(result.root, /^[0-9a-f]{64}$/);
});

test('tampered payload byte is rejected', () => {
  const { storage, log } = committedLog();
  storage.corruptDurable((d) => {
    d[100] ^= 0x01; // inside page 0 payload
    return d;
  });
  const result = log.verify();
  assert.equal(result.valid, false);
  assert.equal(result.violations[0].code, 'CORRUPT');
});

test('tampered commit record is rejected', () => {
  const { storage, log } = committedLog();
  storage.corruptDurable((d) => {
    d[PAGE_SIZE + 20] ^= 0x01; // inside page 0 commit record hash
    return d;
  });
  const result = log.verify();
  assert.equal(result.valid, false);
  assert.equal(result.violations[0].code, 'CORRUPT');
});

test('tampered hash-chain link is rejected', () => {
  const { storage, log } = committedLog();
  storage.corruptDurable((d) => {
    d[STRIDE + 45] ^= 0x01; // page 1 prevHash field
    return d;
  });
  const result = log.verify();
  assert.equal(result.valid, false);
  assert.equal(result.violations[0].code, 'CORRUPT');
  assert.match(result.violations[0].detail, /hash chain|commit/);
});

test('verify never mutates the log', () => {
  const { storage, log } = committedLog();
  storage.corruptDurable((d) => {
    d[100] ^= 0x01;
    return d;
  });
  const before = Buffer.from(storage.volatile);
  log.verify();
  assert.deepEqual(storage.volatile, before, 'verify is read-only');
});

test('uncommitted tail bytes fail verification', () => {
  const { storage, log } = committedLog();
  storage.corruptDurable((d) => Buffer.concat([d, Buffer.from('junk')]));
  const result = log.verify();
  assert.equal(result.valid, false);
  assert.equal(result.violations[0].code, 'CORRUPT');
});
