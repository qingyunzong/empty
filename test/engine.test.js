'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { Engine } = require('../src/engine');
const { EXIT } = require('../src/errors');
const { ev, scenario, scenarioEvents } = require('./helpers');

function applyAll(engine, events) {
  const snaps = [];
  for (const event of events) {
    engine.apply(event);
    snaps.push(engine.snapshot());
  }
  return snaps;
}

// Acceptance 1: a duplicated CORRECT (retransmission) is idempotent.
test('duplicate CORRECT is idempotent', () => {
  const { aPack, aCorrect } = scenario();
  const engine = new Engine();
  engine.apply(aPack);
  engine.apply(aCorrect);
  const before = engine.snapshot();
  assert.equal(engine.apply(aCorrect), 'duplicate');
  assert.equal(engine.apply(aPack), 'duplicate');
  assert.deepEqual(engine.snapshot(), before);
  assert.equal(engine.validCount, 1); // only the correction is valid; pack is superseded
  engine.finalize();
  const state = engine.getItemState('ITEM-A');
  assert.equal(state.qty, 12);
  assert.equal(state.reason, 'miscount');
});

// Acceptance 2: out-of-order delivery changes intermediate states but the
// final state (and content hash) matches the in-order reference.
test('out-of-order delivery converges to the reference final state', () => {
  const events = scenarioEvents();
  const reference = new Engine();
  const refSnaps = applyAll(reference, events);
  reference.finalize();

  const shuffled = [events[2], events[4], events[0], events[5], events[1], events[3]];
  const actual = new Engine();
  const actSnaps = applyAll(actual, shuffled);
  actual.finalize();

  const differs = actSnaps.some((snap, i) => JSON.stringify(snap) !== JSON.stringify(refSnaps[i]));
  assert.ok(differs, 'expected at least one intermediate state to differ');
  assert.deepEqual(actual.snapshot(), reference.snapshot());
  assert.deepEqual(actual.exportPackage(), reference.exportPackage());
});

// Acceptance 3: after SCRAP only admin CORRECT (reason=audit) is accepted,
// and it must not resurrect the item.
test('plain correction after SCRAP is rejected (exit 10)', () => {
  const { bPack, bScrap } = scenario();
  const bad = ev({ batch: 'B1', item: 'ITEM-B', seq: 9, lamport: 6, kind: 'CORRECT', ref: bPack.id, qty: 7, reason: 'recount' });
  const engine = new Engine();
  for (const e of [bPack, bScrap, bad]) engine.apply(e);
  assert.throws(() => engine.finalize(), (err) => err.exitCode === EXIT.TERMINAL);
});

test('PACK after SCRAP is a terminal violation (exit 10)', () => {
  const { bPack, bScrap } = scenario();
  const revive = ev({ batch: 'B1', item: 'ITEM-B', seq: 9, lamport: 6, kind: 'PACK', qty: 3 });
  const engine = new Engine();
  for (const e of [bPack, bScrap, revive]) engine.apply(e);
  assert.throws(() => engine.finalize(), (err) => err.exitCode === EXIT.TERMINAL);
});

test('audit CORRECT after SCRAP is accepted and does not resurrect', () => {
  const { bPack, bScrap, bAudit } = scenario();
  const engine = new Engine();
  for (const e of [bPack, bScrap, bAudit]) engine.apply(e);
  engine.finalize();
  const state = engine.getItemState('ITEM-B');
  assert.equal(state.status, 'SCRAPPED');
  assert.equal(state.scrapped, true);
  assert.equal(state.qty, 4);
  assert.equal(state.reason, 'audit');
});

// Acceptance 4: incremental content hash always equals a full recompute.
test('incremental hash matches full recompute at every step and across orders', () => {
  const events = scenarioEvents();
  const engine = new Engine();
  const hashes = [engine.contentHash()];
  for (const event of events) {
    engine.apply(event);
    assert.equal(engine.contentHash(), engine.recomputeContentHash());
    hashes.push(engine.contentHash());
  }
  engine.finalize();
  assert.equal(engine.contentHash(), engine.recomputeContentHash());
  // Corrections visibly move the hash (incremental update, not a fixed value).
  assert.ok(new Set(hashes).size > 1);

  const shuffled = new Engine();
  for (const event of [events[5], events[3], events[1], events[4], events[2], events[0]]) {
    shuffled.apply(event);
    assert.equal(shuffled.contentHash(), shuffled.recomputeContentHash());
  }
  shuffled.finalize();
  assert.equal(shuffled.contentHash(), engine.contentHash());
});

test('unknown ref is exit 9', () => {
  const ghost = ev({ batch: 'B1', item: 'ITEM-A', seq: 9, lamport: 9, kind: 'CORRECT', ref: '00'.repeat(32), qty: 1, reason: 'miscount' });
  const engine = new Engine();
  engine.apply(ghost);
  assert.throws(() => engine.finalize(), (err) => err.exitCode === EXIT.REF_UNKNOWN);
});

test('CORRECT must not change item/batch (exit 2)', () => {
  const { aPack } = scenario();
  const cross = ev({ batch: 'B1', item: 'ITEM-OTHER', seq: 9, lamport: 9, kind: 'CORRECT', ref: aPack.id, qty: 1, reason: 'miscount' });
  const engine = new Engine();
  engine.apply(aPack);
  engine.apply(cross);
  assert.throws(() => engine.finalize(), (err) => err.exitCode === EXIT.FRAME);
});

test('correction chains: latest correction wins, chain is exported', () => {
  const pack = ev({ batch: 'B1', item: 'ITEM-C', seq: 0, lamport: 1, kind: 'PACK', qty: 10 });
  const c1 = ev({ batch: 'B1', item: 'ITEM-C', seq: 1, lamport: 2, kind: 'CORRECT', ref: pack.id, qty: 11, reason: 'recount' });
  const c2 = ev({ batch: 'B1', item: 'ITEM-C', seq: 2, lamport: 3, kind: 'CORRECT', ref: c1.id, qty: 12, reason: 'audit' });
  const engine = new Engine();
  for (const e of [c2, pack, c1]) engine.apply(e); // out of order on purpose
  engine.finalize();

  const state = engine.getItemState('ITEM-C');
  assert.equal(state.qty, 12);
  assert.equal(state.effectiveEvent, c2.id);
  assert.equal(engine.validCount, 1);

  const pkg = engine.exportPackage();
  assert.deepEqual(pkg.validEvents, [c2.id]);
  assert.equal(pkg.supersededChains.length, 1);
  const chain = pkg.supersededChains[0];
  assert.deepEqual(chain.chain, [pack.id, c1.id, c2.id]);
  assert.deepEqual(chain.superseded, [pack.id, c1.id]);
  assert.equal(chain.effective, c2.id);
  // Superseded events are retained in the package, flagged.
  const byId = new Map(pkg.events.map((e) => [e.id, e]));
  assert.equal(byId.get(pack.id).superseded, true);
  assert.equal(byId.get(c1.id).superseded, true);
  assert.equal(byId.get(c2.id).superseded, false);
});
