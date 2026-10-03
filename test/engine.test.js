'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { Engine, EngineError } = require('../lib/engine');
const { FrameParser, encodeStream, encodeFrame } = require('../lib/frame');
const { summarize, permutations } = require('../oracle/reference');

const KEY = 'test-key';
const f = (authId, type, amount, seq, ack = 0) => ({ authId, type, amount, seq, ack });
const rec = (frame) => ({ macOk: true, offset: 0, frame });

function run(frames, opts = {}) {
  const e = new Engine(opts);
  for (const frame of frames) e.ingest(rec(frame));
  return e;
}

// Acceptance 1: inc over limit is partially rejected.
test('inc exceeding limit is partially accepted', () => {
  const e = run([f('A', 'hold', 500, 1), f('A', 'inc', 700, 2)], { limit: 1000 });
  const a = e.report().auths.A;
  assert.equal(a.frozen, 1000);
  assert.equal(a.available, 0);
  const partial = a.certificate.find((c) => c.event === 'inc_partial');
  assert.ok(partial, 'expected inc_partial evidence');
  assert.equal(partial.amount, 500);
  assert.equal(partial.rejectedAmount, 200);
});

// Acceptance 2: dec/complete race — a buffered complete pins the frozen floor.
test('dec is clamped by buffered complete candidate (race)', () => {
  const e = run(
    [f('A', 'hold', 1000, 1), f('A', 'complete', 600, 3), f('A', 'dec', 500, 2)],
    { limit: 2000 },
  );
  const a = e.report().auths.A;
  assert.equal(a.status, 'COMPLETED');
  assert.equal(a.charged, 600);
  assert.equal(a.frozen, 0);
  const events = a.certificate.map((c) => c.event);
  assert.deepEqual(events, ['hold', 'buffered', 'dec_partial', 'complete']);
  const dec = a.certificate.find((c) => c.event === 'dec_partial');
  assert.equal(dec.amount, 400); // 1000 - floor(600)
  assert.equal(dec.rejectedAmount, 100);
});

// Acceptance 3: duplicate complete is idempotent; a new complete after
// COMPLETED is rejected but recorded as evidence.
test('duplicate complete is idempotent, late complete rejected with evidence', () => {
  const e = run([
    f('A', 'hold', 800, 1),
    f('A', 'complete', 500, 2),
    f('A', 'complete', 500, 2), // retransmission
    f('A', 'complete', 600, 3), // late, different seq
  ], { limit: 1000 });
  const a = e.report().auths.A;
  assert.equal(a.status, 'COMPLETED');
  assert.equal(a.charged, 500);
  assert.equal(a.ack, 3);
  const events = a.certificate.map((c) => c.event);
  assert.deepEqual(events, ['hold', 'complete', 'duplicate', 'rejected']);
  const late = a.certificate.find((c) => c.event === 'rejected');
  assert.match(late.note, /late complete/);
});

// Acceptance 4: expiry auto-voids; late inc / complete are rejected with evidence.
test('expired hold auto-voids; late inc and complete rejected with evidence', () => {
  const e = run([
    f('A', 'hold', 400, 1),               // clock 1, expires at tick 4
    f('B', 'hold', 100, 1),               // clock 2
    f('B', 'inc', 50, 2),                 // clock 3
    f('B', 'dec', 20, 3),                 // clock 4
    f('B', 'void', 0, 4),                 // clock 5 -> A auto-voids first
    f('A', 'inc', 100, 2),                // clock 6: late
    f('A', 'complete', 300, 3),           // clock 7: late
  ], { limit: 1000, ttl: 3 });
  const r = e.report();
  const a = r.auths.A;
  assert.equal(a.status, 'VOIDED');
  assert.equal(a.frozen, 0);
  assert.equal(a.charged, 0);
  const autoVoid = a.certificate.find((c) => c.event === 'auto_void');
  assert.ok(autoVoid, 'expected auto_void certificate');
  assert.equal(autoVoid.clock, 5);
  const lates = a.certificate.filter((c) => c.event === 'rejected');
  assert.equal(lates.length, 2);
  assert.match(lates[0].note, /late inc/);
  assert.match(lates[1].note, /late complete/);
  assert.equal(r.auths.B.status, 'VOIDED'); // explicit void of remaining 130
});

// reverse: only after COMPLETED, full amount, generates reverse ledger entry.
test('reverse only reverses a completed auth and writes reverse ledger', () => {
  const e = run([
    f('A', 'hold', 900, 1),
    f('A', 'reverse', 400, 2), // rejected: not completed
    f('A', 'complete', 400, 3),
    f('A', 'reverse', 300, 4), // rejected: amount mismatch
    f('A', 'reverse', 400, 5), // ok
    f('A', 'reverse', 400, 6), // rejected: already reversed
  ], { limit: 1000 });
  const a = e.report().auths.A;
  assert.equal(a.status, 'REVERSED');
  assert.equal(a.charged, 0);
  const kinds = a.ledger.map((l) => l.kind);
  assert.deepEqual(kinds, ['hold', 'complete', 'release', 'reverse']);
  const reverse = a.ledger.find((l) => l.kind === 'reverse');
  assert.equal(reverse.amount, 400);
  assert.equal(reverse.chargedAfter, 0);
  const rejected = a.certificate.filter((c) => c.event === 'rejected');
  assert.equal(rejected.length, 3);
});

// Dedup / conflict semantics.
test('same seq different payload is a conflict (exit 3)', () => {
  const e = new Engine({ limit: 1000 });
  e.ingest(rec(f('A', 'hold', 100, 1)));
  e.ingest(rec(f('A', 'inc', 50, 2)));
  assert.throws(() => e.ingest(rec(f('A', 'inc', 60, 2))), (err) => {
    assert.ok(err instanceof EngineError);
    assert.equal(err.code, 3);
    return true;
  });
});

test('retransmission with identical payload is an idempotent no-op', () => {
  const e = run([
    f('A', 'hold', 100, 1), f('A', 'hold', 100, 1), f('A', 'inc', 50, 2), f('A', 'inc', 50, 2),
  ], { limit: 1000 });
  const a = e.report().auths.A;
  assert.equal(a.frozen, 150);
  assert.equal(a.certificate.filter((c) => c.event === 'duplicate').length, 2);
});

test('mac mismatch raises exit-2 error', () => {
  const e = new Engine({ limit: 1000 });
  assert.throws(() => e.ingest({ macOk: false, offset: 42, frame: null }), (err) => {
    assert.equal(err.code, 2);
    return true;
  });
});

test('complete exceeding frozen raises exit-4 (negative frozen)', () => {
  const e = new Engine({ limit: 1000 });
  e.ingest(rec(f('A', 'hold', 300, 1)));
  assert.throws(() => e.ingest(rec(f('A', 'complete', 500, 2))), (err) => {
    assert.equal(err.code, 4);
    return true;
  });
});

// Fragmentation: parser reassembles frames split at every byte boundary.
test('frame parser reassembles arbitrary fragmentation', () => {
  const frames = [f('A', 'hold', 100, 1), f('B', 'inc', 5, 2), f('C', 'complete', 9, 3)];
  const stream = encodeStream(frames, KEY);
  for (let cut = 0; cut <= stream.length; cut += 1) {
    const p = new FrameParser(KEY);
    const got = [...p.push(stream.subarray(0, cut)), ...p.push(stream.subarray(cut))];
    assert.equal(got.length, 3, `cut at ${cut}`);
    assert.ok(got.every((g) => g.macOk));
    assert.deepEqual(got.map((g) => g.frame), frames);
    assert.equal(p.pendingBytes, 0);
  }
  // byte-by-byte drip feed
  const p = new FrameParser(KEY);
  let got = [];
  for (let i = 0; i < stream.length; i += 1) got = got.concat(p.push(stream.subarray(i, i + 1)));
  assert.equal(got.length, 3);
  assert.deepEqual(got.map((g) => g.frame), frames);
});

test('mac verifies over tampered bytes', () => {
  const buf = Buffer.from(encodeFrame(f('A', 'hold', 100, 1), KEY));
  buf[6] ^= 0x01; // flip a body byte
  const p = new FrameParser(KEY);
  const got = p.push(buf);
  assert.equal(got.length, 1);
  assert.equal(got[0].macOk, false);
});

// Acceptance 5: enumerate every arrival order of <=7 frames and compare
// the engine against the independent reference state machine.
function engineSummary(frames, opts) {
  const e = new Engine(opts);
  try {
    for (const frame of frames) e.ingest(rec(frame));
  } catch (err) {
    if (err instanceof EngineError) return { error: err.code };
    throw err;
  }
  const r = e.report().auths;
  const out = {};
  for (const [id, a] of Object.entries(r)) {
    out[id] = {
      status: a.status, frozen: a.frozen, charged: a.charged,
      available: a.available, ack: a.ack, ledger: a.ledger,
    };
  }
  return out;
}

function referenceSummary(frames, opts) {
  try {
    return summarize(frames, opts);
  } catch (err) {
    if (typeof err.code === 'number') return { error: err.code };
    throw err;
  }
}

function checkAllOrders(name, frames, opts) {
  assert.ok(frames.length <= 7);
  let checked = 0;
  let errored = 0;
  for (const order of permutations(frames)) {
    const got = engineSummary(order, opts);
    const want = referenceSummary(order, opts);
    assert.deepEqual(got, want, `${name} mismatch for order ${order.map((x) => `${x.authId}:${x.type}#${x.seq}`).join(',')}`);
    checked += 1;
    if (got.error) errored += 1;
  }
  return { checked, errored };
}

test('enumeration: 7-frame mixed lifecycle matches reference in every order', () => {
  // Includes a dec/complete race: orders where complete(4) is still buffered
  // when dec(3) applies clamp the dec; orders where dec applies first make
  // complete(4) exceed frozen -> exit 4. Both paths must match the oracle.
  const frames = [
    f('A', 'hold', 800, 1),
    f('A', 'inc', 400, 2),   // limit 1000 -> partial +200
    f('A', 'dec', 500, 3),
    f('A', 'complete', 700, 4),
    f('A', 'reverse', 700, 5),
    f('A', 'void', 0, 6),    // rejected: terminal by then (or never active)
    f('A', 'inc', 50, 7),    // late / rejected
  ];
  const { checked, errored } = checkAllOrders('lifecycle', frames, { limit: 1000, ttl: 1000 });
  assert.equal(checked, 5040);
  assert.ok(errored > 0, 'expected some orders to hit exit-4 race');
});

test('enumeration: 6-frame two-auth expiry scenario matches reference', () => {
  const frames = [
    f('A', 'hold', 300, 1),
    f('A', 'inc', 100, 2),
    f('A', 'complete', 200, 3),
    f('B', 'hold', 500, 1),
    f('B', 'dec', 100, 2),
    f('B', 'void', 0, 3),
  ];
  const { checked } = checkAllOrders('expiry', frames, { limit: 1000, ttl: 2 });
  assert.equal(checked, 720);
});

test('enumeration: 7-frame stream with a retransmitted complete matches reference', () => {
  const frames = [
    f('A', 'hold', 600, 1),
    f('A', 'complete', 250, 2),
    f('A', 'complete', 250, 2), // retransmission: idempotent
    f('A', 'reverse', 250, 3),
    f('A', 'reverse', 250, 4), // rejected: already reversed
    f('A', 'void', 0, 5),      // rejected: terminal
    f('A', 'hold', 100, 6),    // rejected: not INIT
  ];
  const { checked } = checkAllOrders('dup', frames, { limit: 1000, ttl: 1000 });
  assert.equal(checked, 5040);
});
