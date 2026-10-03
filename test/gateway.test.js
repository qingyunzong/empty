'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { Gateway } = require('../lib/gateway');
const { Ledger } = require('../lib/ledger');
const { frame, runStream, businessEvents } = require('./helpers');

test('acceptance 1: sticky + half-frame stream delivers events in reference order', () => {
  const buffers = [
    frame(0, 'WELD_START', { orderId: 'A', weldId: 'w0' }),
    frame(1, 'WELD_END', { orderId: 'A', weldId: 'w0' }),
    frame(2, 'WELD_START', { orderId: 'B', weldId: 'w1' }),
    frame(3, 'WELD_END', { orderId: 'B', weldId: 'w1' }),
    frame(4, 'UNDO', { orderId: 'B', targetSeq: 3 }),
  ];
  const { events, gateway } = runStream(buffers, { chunkSize: 1 }); // half-frame stress
  assert.equal(gateway.error, null);
  assert.deepEqual(businessEvents(events), [
    { event: 'WELD_START', seq: 0, orderId: 'A', weldId: 'w0' },
    { event: 'WELD_END', seq: 1, orderId: 'A', weldId: 'w0' },
    { event: 'WELD_START', seq: 2, orderId: 'B', weldId: 'w1' },
    { event: 'WELD_END', seq: 3, orderId: 'B', weldId: 'w1' },
    { event: 'WELD_END_REVERSED', seq: 4, orderId: 'B', targetSeq: 3 },
  ]);
  const cert = events[events.length - 1].certificate;
  assert.equal(cert.ok, true);
  assert.equal(cert.delivered, 5);
});

test('acceptance 2: duplicate seq and timeout retransmission never double-post', () => {
  const buffers = [
    frame(0, 'WELD_START', { orderId: 'A', weldId: 'w0' }),
    frame(0, 'WELD_START', { orderId: 'A', weldId: 'w0' }), // exact duplicate
    frame(2, 'WELD_END', { orderId: 'A', weldId: 'w0' }),   // out of order: gap at 1
    frame(2, 'WELD_END', { orderId: 'A', weldId: 'w0' }),   // duplicate of buffered
    frame(1, 'WELD_START', { orderId: 'A', weldId: 'w9' }), // retransmitted frame fills gap
    frame(1, 'WELD_START', { orderId: 'A', weldId: 'w9' }), // duplicate retransmission
  ];
  const { events, gateway } = runStream(buffers, { timeout: 2, maxRetries: 3 });
  assert.equal(gateway.error, null);
  const biz = businessEvents(events);
  assert.deepEqual(biz.map((e) => e.seq), [0, 1, 2]);
  assert.equal(biz.filter((e) => e.event === 'WELD_START').length, 2);
  assert.equal(biz.filter((e) => e.event === 'WELD_END').length, 1);
  const dupDrops = events.filter((e) => e.event === 'DUPLICATE_DROPPED');
  assert.equal(dupDrops.length, 3);
  const requests = events.filter((e) => e.event === 'RETRANSMIT_REQUEST');
  assert.ok(requests.length >= 1);
  assert.deepEqual([requests[0].from, requests[0].to], [1, 1]);
  const cert = events[events.length - 1].certificate;
  assert.equal(cert.frames, 6);
  assert.equal(cert.delivered, 3);
  assert.equal(cert.duplicates, 3);
});

test('gap timeout exhausts retries into SEQ_GAP_TIMEOUT (exit-3 class)', () => {
  const { events, gateway } = runStream(
    [frame(1, 'WELD_END', { orderId: 'A' })], // seq 0 never arrives
    { timeout: 1, maxRetries: 2 },
  );
  assert.deepEqual(gateway.error.code, 'SEQ_GAP_TIMEOUT');
  const requests = events.filter((e) => e.event === 'RETRANSMIT_REQUEST');
  assert.equal(requests.length, 2); // attempts 1 and 2, then give up
  assert.equal(events[events.length - 1].certificate.ok, false);
});

test('acceptance 3a: cross-order UNDO fails, state unchanged', () => {
  const gateway = new Gateway();
  const ingest = (buf) => gateway.ingest(decodeOne(buf));
  ingest(frame(0, 'WELD_START', { orderId: 'A' }));
  ingest(frame(1, 'WELD_END', { orderId: 'A', weldId: 'w0' }));
  const before = snapshot(gateway.ledger);
  const events = ingest(frame(2, 'UNDO', { orderId: 'B', targetSeq: 1 }));
  assert.equal(gateway.error.code, 'CROSS_ORDER_UNDO');
  assert.deepEqual(events, []); // no reverse event emitted
  assert.deepEqual(snapshot(gateway.ledger), before); // state unchanged
});

test('acceptance 3b: UNDO of already-closed end fails, state unchanged', () => {
  const gateway = new Gateway();
  const ingest = (buf) => gateway.ingest(decodeOne(buf));
  ingest(frame(0, 'WELD_END', { orderId: 'A', weldId: 'w0' }));
  const ok = ingest(frame(1, 'UNDO', { orderId: 'A', targetSeq: 0 }));
  assert.equal(ok[0].event, 'WELD_END_REVERSED');
  const before = snapshot(gateway.ledger);
  const events = ingest(frame(2, 'UNDO', { orderId: 'A', targetSeq: 0 }));
  assert.equal(gateway.error.code, 'UNDO_ALREADY_CLOSED');
  assert.deepEqual(events, []);
  assert.deepEqual(snapshot(gateway.ledger), before);
});

test('UNDO covered by a later START fails', () => {
  const gateway = new Gateway();
  const ingest = (buf) => gateway.ingest(decodeOne(buf));
  ingest(frame(0, 'WELD_END', { orderId: 'A', weldId: 'w0' }));
  ingest(frame(1, 'WELD_START', { orderId: 'A', weldId: 'w1' }));
  const events = ingest(frame(2, 'UNDO', { orderId: 'A', targetSeq: 0 }));
  assert.equal(gateway.error.code, 'UNDO_COVERED_BY_START');
  assert.deepEqual(events, []);
  assert.equal(gateway.ledger.ends.get(0).undone, false);
});

test('valid UNDO keeps original event and appends reverse event', () => {
  const gateway = new Gateway();
  const ingest = (buf) => gateway.ingest(decodeOne(buf));
  const e0 = ingest(frame(0, 'WELD_END', { orderId: 'A', weldId: 'w0' }));
  const e1 = ingest(frame(1, 'UNDO', { orderId: 'A', targetSeq: 0 }));
  assert.deepEqual(e0, [{ event: 'WELD_END', seq: 0, orderId: 'A', weldId: 'w0' }]);
  assert.deepEqual(e1, [{ event: 'WELD_END_REVERSED', seq: 1, orderId: 'A', targetSeq: 0 }]);
  assert.equal(gateway.ledger.ends.get(0).undone, true);
});

test('ledger rejects malformed payloads as protocol violations', () => {
  const ledger = new Ledger();
  assert.throws(
    () => ledger.apply({ type: 0x01, seq: 0, payload: {} }),
    (err) => err.code === 'INVALID_PAYLOAD',
  );
});

function decodeOne(buf) {
  const { Framer } = require('../lib/framer');
  const framer = new Framer();
  const frames = [...framer.push(buf), ...framer.end()];
  assert.equal(frames.length, 1);
  return frames[0];
}

function snapshot(ledger) {
  return JSON.stringify({
    orders: [...ledger.orders.entries()],
    ends: [...ledger.ends.entries()],
  });
}
