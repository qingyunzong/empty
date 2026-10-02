'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { Engine } = require('../src/sim');
const { encodeFrame, TYPE_DATA, FLAG_EOB } = require('../src/frame');
const { crc32 } = require('../src/crc32');
const { ProtocolError, BusinessError } = require('../src/errors');

const L = (lineNo, amount, currency, direction) => ({ lineNo, amount, currency, direction });

test('acceptance 1: multi-batch out-of-order delivery with retransmit and duplicates', () => {
  const engine = new Engine({ rtoMs: 500 });
  engine.submit({
    batch: 1, timeoutMs: 100000,
    lines: [L(1, '100.00', 'USD', 'pay'), L(2, '200.00', 'EUR', 'pay'), L(3, '50.00', 'USD', 'receive')],
  });
  engine.submit({ batch: 2, timeoutMs: 100000, lines: [L(1, '10.00', 'USD', 'pay')] });
  assert.equal(engine.result().frozen, '310.00');

  // Interleaved, out of order; 1:2 dropped, 1:1 duplicated.
  engine.pump({ order: ['2:1', '1:3', '1:1', '1:2'], drop: ['1:2'], dup: ['1:1'] });
  let r = engine.result();
  assert.equal(r.lines.find((l) => l.batch === 1 && l.lineNo === 1).state, 'ACKED');
  assert.equal(r.lines.find((l) => l.batch === 1 && l.lineNo === 2).state, 'OPEN');
  assert.equal(r.lines.find((l) => l.batch === 1 && l.lineNo === 3).state, 'OPEN'); // buffered out of order
  assert.equal(r.lines.find((l) => l.batch === 2 && l.lineNo === 1).state, 'SETTLED');

  // Retransmit timer fires on the virtual clock; dropped frame is resent,
  // the duplicate of an already-acked frame is deduped by the receiver.
  engine.tick(500);
  engine.pump();
  r = engine.result();
  for (const l of r.lines) assert.equal(l.state, 'SETTLED');
  assert.equal(r.frozen, '0.00');
  assert.equal(r.settledPay, '310.00');
  assert.equal(r.settledReceive, '50.00');
  assert.equal(r.audit.valid, true);
});

test('acceptance 2: CRC error and half-frame delivery recover via retransmission', () => {
  const engine = new Engine({ rtoMs: 500 });
  engine.submit({ batch: 1, timeoutMs: 100000, lines: [L(1, '5.00', 'USD', 'pay'), L(2, '7.00', 'USD', 'pay')] });

  engine.pump({ corrupt: ['1:1'] });
  assert.equal(engine.receiver.errors.length, 1);
  assert.equal(engine.receiver.errors[0].code, 'CRC_MISMATCH');
  let r = engine.result();
  assert.equal(r.lines[0].state, 'OPEN');
  assert.equal(r.lines[1].state, 'OPEN'); // frame 2 buffered out of order

  engine.tick(500); // retransmit both unacked frames
  engine.pump({ split: [['1:1', 9]] }); // frame 1 arrives as two half frames
  r = engine.result();
  for (const l of r.lines) assert.equal(l.state, 'SETTLED');
  assert.equal(r.frozen, '0.00');
  assert.equal(r.settledPay, '12.00');
  assert.equal(r.audit.valid, true);
});

test('half frame is held until the rest arrives; bad magic is a protocol error', () => {
  const engine = new Engine();
  engine.submit({ batch: 1, timeoutMs: 100000, lines: [L(1, '5.00', 'USD', 'pay')] });
  const [buf] = engine.sender.drain();
  const half = Math.floor(buf.length / 2);
  engine.receiver.feed(buf.subarray(0, half));
  assert.equal(engine.receiver.drainLines().length, 0); // nothing delivered yet
  engine.receiver.feed(buf.subarray(half));
  engine.flush();
  assert.equal(engine.result().lines[0].state, 'SETTLED');

  // Valid CRC but wrong magic -> unrecoverable protocol error.
  const good = encodeFrame({ type: TYPE_DATA, batchId: 9, lineNo: 1, seq: 1, flags: FLAG_EOB });
  const bad = Buffer.from(good);
  bad[2] = 0x00;
  bad[3] = 0x00;
  const bodyLen = bad.readUInt16BE(0);
  bad.writeUInt32BE(crc32(bad.subarray(2, 2 + bodyLen - 4)), 2 + bodyLen - 4);
  assert.throws(() => engine.receiver.feed(bad), ProtocolError);
});

test('settled line is corrected only by a reversal line; history stays immutable', () => {
  const engine = new Engine();
  engine.submit({ batch: 1, timeoutMs: 100000, lines: [L(1, '100.00', 'USD', 'pay')] });
  engine.pump();
  assert.equal(engine.result().lines[0].state, 'SETTLED');

  assert.throws(() => engine.reverse({ batch: 2, lineNo: 1, of: { batch: 1, lineNo: 99 } }), BusinessError);
  engine.submit({ batch: 3, timeoutMs: 100000, lines: [L(1, '1.00', 'USD', 'pay')] });
  assert.throws(
    () => engine.reverse({ batch: 4, lineNo: 1, of: { batch: 3, lineNo: 1 } }),
    /not SETTLED/,
  );

  engine.reverse({ batch: 5, lineNo: 1, of: { batch: 1, lineNo: 1 }, timeoutMs: 100000 });
  engine.pump();
  const r = engine.result();
  const rev = r.lines.find((l) => l.batch === 5);
  assert.equal(rev.state, 'SETTLED');
  assert.equal(rev.direction, 'receive'); // contra entry of the original pay
  assert.deepEqual(rev.reversalOf, { batch: 1, lineNo: 1 });
  assert.equal(r.lines.find((l) => l.batch === 1).state, 'SETTLED'); // original untouched
  assert.equal(r.settledReceive, '100.00');
  assert.equal(r.audit.valid, true);
});
