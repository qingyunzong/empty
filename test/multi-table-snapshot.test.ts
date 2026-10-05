import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Database } from '../src/mvcc.js';

test('a query spanning multiple tables sees one consistent snapshot', () => {
  const db = new Database();
  db.createTable('orders');
  db.createTable('order_items');

  const seed = db.begin();
  seed.write('orders', 'o1', 'open');
  seed.write('order_items', 'o1#1', 'book');
  seed.commit();

  // Long-running reader: joins orders with order_items.
  const report = db.begin();
  assert.equal(report.read('orders', 'o1'), 'open');

  // Concurrent writer commits changes to BOTH tables in one commit.
  const writer = db.begin();
  writer.write('orders', 'o1', 'shipped');
  writer.write('order_items', 'o1#1', 'book+gift-wrap');
  writer.write('orders', 'o2', 'open');
  writer.commit();

  // The reader still sees the old, mutually consistent state of both tables.
  assert.equal(report.read('orders', 'o1'), 'open');
  assert.equal(report.read('order_items', 'o1#1'), 'book');
  assert.equal(report.read('orders', 'o2'), undefined);
  assert.deepEqual(report.scan('orders'), [['o1', 'open']]);

  // A new transaction sees the new consistent state of both tables.
  const fresh = db.begin();
  assert.equal(fresh.read('orders', 'o1'), 'shipped');
  assert.equal(fresh.read('order_items', 'o1#1'), 'book+gift-wrap');
  assert.equal(fresh.read('orders', 'o2'), 'open');
});
