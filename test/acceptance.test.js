'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { Ledger } = require('../src/ledger');
const { TerminalViolationError } = require('../src/errors');
const { makeEvent, shuffled, feedAll, eventId } = require('./helpers');

function scenario() {
  const pack = makeEvent({ batch: 'B1', item: 'ITEM-1', seq: 1, lamport: 1, kind: 'PACK', qty: 10 });
  const rework = makeEvent({ batch: 'B1', item: 'ITEM-1', seq: 2, lamport: 2, kind: 'REWORK', qty: 3 });
  const fixPack = makeEvent({
    batch: 'B1', item: 'ITEM-1', seq: 3, lamport: 3, kind: 'CORRECT',
    ref: eventId(pack), qty: 12, reason: 'recount',
  });
  const scrap = makeEvent({ batch: 'B1', item: 'ITEM-1', seq: 4, lamport: 4, kind: 'SCRAP', qty: 2 });
  const auditFix = makeEvent({
    batch: 'B1', item: 'ITEM-1', seq: 5, lamport: 5, kind: 'CORRECT',
    ref: eventId(scrap), qty: 1, reason: 'audit',
  });
  const other = makeEvent({ batch: 'B1', item: 'ITEM-2', seq: 1, lamport: 6, kind: 'PACK', qty: 7 });
  return [pack, rework, fixPack, scrap, auditFix, other];
}

test('acceptance 1: duplicate CORRECT is idempotent', () => {
  const events = scenario();
  const once = new Ledger();
  feedAll(once, events);

  const dup = new Ledger();
  for (const e of events) {
    dup.ingest(e);
    dup.ingest(e); // exact duplicate delivery
  }
  assert.equal(dup.ingest(events[2]), false); // CORRECT seen again -> no-op

  assert.equal(once.contentHash(), dup.contentHash());
  assert.deepEqual(dup.exportPackage(), once.exportPackage());
  assert.equal(dup.exportPackage().eventCount, events.length); // no double count
});

test('acceptance 2: out-of-order delivery changes intermediate states but converges', () => {
  const events = scenario();
  const reference = new Ledger();
  const refSnapshots = feedAll(reference, events);

  const reordered = shuffled(events);
  assert.notDeepEqual(reordered.map(eventId), events.map(eventId)); // actually different order
  const shuffledLedger = new Ledger();
  const shuffledSnapshots = feedAll(shuffledLedger, reordered);

  // intermediate states differ at least at one step
  assert.ok(refSnapshots.some((snap, i) => snap !== shuffledSnapshots[i]));

  // final state is identical to the reference, including content hash
  const refPkg = reference.exportPackage();
  const finalPkg = shuffledLedger.exportPackage();
  assert.deepEqual(finalPkg, refPkg);
  assert.equal(finalPkg.contentHash, refPkg.contentHash);
});

test('acceptance 3: non-audit correction after SCRAP is rejected, audit does not resurrect', () => {
  const pack = makeEvent({ batch: 'B1', item: 'I', seq: 1, lamport: 1, kind: 'PACK', qty: 10 });
  const scrap = makeEvent({ batch: 'B1', item: 'I', seq: 2, lamport: 2, kind: 'SCRAP', qty: 4 });

  // plain correction of PACK after terminal SCRAP -> exit 10
  const badFix = makeEvent({
    batch: 'B1', item: 'I', seq: 3, lamport: 3, kind: 'CORRECT',
    ref: eventId(pack), qty: 9, reason: 'recount',
  });
  const ledger = new Ledger();
  for (const e of [pack, scrap, badFix]) ledger.ingest(e);
  assert.throws(() => ledger.finalize(), (err) => {
    assert.ok(err instanceof TerminalViolationError);
    assert.equal(err.exitCode, 10);
    return true;
  });

  // new PACK after SCRAP -> exit 10 as well
  const ledger2 = new Ledger();
  const latePack = makeEvent({ batch: 'B1', item: 'I', seq: 4, lamport: 4, kind: 'PACK', qty: 1 });
  for (const e of [pack, scrap, latePack]) ledger2.ingest(e);
  assert.throws(() => ledger2.finalize(), (err) => err.exitCode === 10);

  // admin audit correction of the SCRAP event is accepted and does not resurrect
  const auditFix = makeEvent({
    batch: 'B1', item: 'I', seq: 5, lamport: 5, kind: 'CORRECT',
    ref: eventId(scrap), qty: 3, reason: 'audit',
  });
  const ledger3 = new Ledger();
  feedAll(ledger3, [pack, scrap, auditFix]);
  const pkg = ledger3.exportPackage();
  assert.equal(pkg.items['I'].state, 'SCRAPPED'); // still terminal, not resurrected
  assert.equal(pkg.items['I'].qty, 3);            // audit-adjusted quantity
  assert.equal(pkg.items['I'].scrapped, true);
});

test('acceptance 4: incremental hash always equals full recompute', () => {
  const events = scenario();
  const ledger = new Ledger();
  for (const e of shuffled(events)) {
    ledger.ingest(e);
    assert.equal(ledger.contentHash(), ledger.recomputeHash());
  }
  // duplicates and supersession flips keep the invariant
  for (const e of events) {
    ledger.ingest(e);
    assert.equal(ledger.contentHash(), ledger.recomputeHash());
  }
  // hash is sensitive to corrections (supersession changes it)
  const before = new Ledger();
  feedAll(before, events.slice(0, 2));
  const after = new Ledger();
  feedAll(after, events.slice(0, 3));
  assert.notEqual(before.contentHash(), after.contentHash());
});
