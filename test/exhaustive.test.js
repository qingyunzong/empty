'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { Engine } = require('../lib/engine');
const { linearize } = require('../lib/linearize');

const LIMIT = 1000;
const TTL = 1e9;

function permute(items) {
  if (items.length <= 1) return [items];
  const out = [];
  for (let i = 0; i < items.length; i++) {
    const rest = items.slice(0, i).concat(items.slice(i + 1));
    for (const tail of permute(rest)) out.push([items[i], ...tail]);
  }
  return out;
}

function runAll(ops) {
  const e = new Engine({ creditLimit: LIMIT, authTtlMs: TTL });
  const trace = [e.available];
  for (const op of ops) {
    e.apply(op);
    trace.push(e.available);
    assert.ok(e.available >= 0, `available went negative: ${e.available}`);
    assert.ok(e.available <= LIMIT, `available exceeded limit: ${e.available}`);
  }
  return { engine: e, trace };
}

// Acceptance 4: exhaustively interleave <= 6 concurrent ops and check every
// interleaving against the serial reference. All ops commute (buffering
// resolves ref order; the two refunds are both within the captured total),
// so every permutation must converge to the reference final state.
test('acceptance 4: 6-op exhaustive interleaving matches serial reference', () => {
  const ops = [
    { idemKey: 'a1', type: 'auth', amount: 100, seq: 1, ts: 0 },
    { idemKey: 'a2', type: 'auth', amount: 50, seq: 2, ts: 0 },
    { idemKey: 'c1', type: 'capture', ref: 'a1', amount: 60, seq: 3, ts: 0 },
    { idemKey: 'r1', type: 'refund', ref: 'c1', amount: 20, seq: 4, ts: 0 },
    { idemKey: 'r2', type: 'refund', ref: 'c1', amount: 10, seq: 5, ts: 0 },
    { idemKey: 'v1', type: 'void', ref: 'a2', seq: 6, ts: 0 },
  ];
  const reference = runAll(ops);
  assert.equal(reference.engine.available, 970); // 1000 - 60 + 20 + 10

  const perms = permute(ops);
  assert.equal(perms.length, 720);
  for (const perm of perms) {
    const { engine } = runAll(perm);
    assert.equal(
      engine.available,
      reference.engine.available,
      `diverged for order: ${perm.map((o) => o.idemKey).join(',')}`
    );
    const cert = linearize(engine.ledger);
    assert.equal(cert.linearizable, true, cert.reason);
    assert.equal(cert.order.length, 6);
  }
});

test('acceptance 4b: 4-op set with reversal converges on every interleaving', () => {
  const ops = [
    { idemKey: 'a1', type: 'auth', amount: 100, seq: 1, ts: 0 },
    { idemKey: 'a2', type: 'auth', amount: 50, seq: 2, ts: 0 },
    { idemKey: 'c1', type: 'capture', ref: 'a1', amount: 60, seq: 3, ts: 0 },
    { idemKey: 'v1', type: 'reversal', ref: 'c1', seq: 4, ts: 0 },
  ];
  const reference = runAll(ops);
  assert.equal(reference.engine.available, 950); // 1000 - 50 - 60 + 60

  for (const perm of permute(ops)) {
    const { engine } = runAll(perm);
    assert.equal(engine.available, reference.engine.available);
    // the capture event is never deleted; the reversal compensates it
    const types = engine.ledger.map((ev) => ev.type);
    assert.ok(types.includes('capture'));
    assert.ok(types.includes('reversal'));
  }
});
