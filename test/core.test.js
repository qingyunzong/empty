import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  canonical,
  digestOf,
  effectivePriority,
  buildCertificate,
  verifyCertificate,
} from '../src/core.js';

test('canonical JSON is key-order independent', () => {
  const a = { x: 1, y: [3, { b: 2, a: 1 }], z: 's' };
  const b = { z: 's', y: [3, { a: 1, b: 2 }], x: 1 };
  assert.equal(canonical(a), canonical(b));
  assert.equal(digestOf(a), digestOf(b));
});

test('aging: +1 level per k slots waited, capped at +2', () => {
  const req = { priority: 1, submitSlot: 10 };
  assert.equal(effectivePriority(req, 10, 3), 1);
  assert.equal(effectivePriority(req, 12, 3), 1);
  assert.equal(effectivePriority(req, 13, 3), 2);
  assert.equal(effectivePriority(req, 16, 3), 3);
  assert.equal(effectivePriority(req, 100, 3), 3);
});

test('certificate verifies and detects tampering', () => {
  const auths = new Map([
    ['a1', { id: 'a1', card: 'gold', amount: 40, priority: 1, expirySlot: 5, status: 'active' }],
    ['a2', { id: 'a2', card: 'gold', amount: 30, priority: 0, expirySlot: 6, status: 'active' }],
    ['a3', { id: 'a3', card: 'gold', amount: 10, priority: 2, expirySlot: 7, status: 'captured' }],
  ]);
  const cert = buildCertificate(2, auths, new Map([['gold', 100]]), 200);
  assert.equal(cert.pool.used, 70);
  assert.equal(cert.cards.gold.used, 70);
  assert.ok(cert.pool.ok && cert.cards.gold.ok);
  assert.ok(verifyCertificate(cert));

  const tampered = { ...cert, pool: { ...cert.pool, used: 1 } };
  assert.equal(verifyCertificate(tampered), false);

  const over = buildCertificate(
    2,
    new Map([['a9', { id: 'a9', card: 'gold', amount: 150, priority: 0, expirySlot: 5, status: 'active' }]]),
    new Map([['gold', 100]]),
    200,
  );
  assert.equal(over.cards.gold.ok, false);
  assert.equal(verifyCertificate(over), false);
});
