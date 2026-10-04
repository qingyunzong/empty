import test from 'node:test';
import assert from 'node:assert/strict';
import { tmpdir, cli, addLot, addEvent } from '../testkit/helpers.js';
import { Store, syncStores } from '../src/store.js';
import { makeLot, makeEvent } from '../src/core.js';

function seedStore(dir, site) {
  const s = Store.open(dir);
  s.appendRecord(makeLot({ id: 'A', mass: 100, unit: 'kg', site, seq: s.nextSeq(site), createdAt: 1 }));
  s.appendRecord(makeLot({ id: 'B', mass: 50, unit: 'kg', site, seq: s.nextSeq(site), createdAt: 1 }));
  s.appendRecord(makeEvent({ op: 'merge', inputs: [{ lot: 'A', mass: 60 }, { lot: 'B', mass: 50 }], outputs: [{ lot: 'C', mass: 110 }], ts: 2, site, seq: s.nextSeq(site) }));
  return s;
}

test('bidirectional sync converges version vectors and records', () => {
  const dirA = tmpdir();
  const dirB = tmpdir();
  const a = seedStore(dirA, 'f1');
  const b = Store.open(dirB);
  b.appendRecord(makeLot({ id: 'X', mass: 20, unit: 'kg', site: 'f2', seq: b.nextSeq('f2'), createdAt: 1 }));

  const moved = syncStores(a, b);
  assert.ok(moved.toB >= 3);
  assert.equal(moved.toA, 1);
  assert.deepEqual(a.vv, b.vv);
  assert.equal(a.records.length, b.records.length);
  assert.ok(b.graph.lots.has('C'));
  assert.ok(a.graph.lots.has('X'));

  const again = syncStores(a, b);
  assert.deepEqual(again, { toB: 0, toA: 0 }); // idempotent
  a.close();
  b.close();
});

test('duplicate records are idempotent', () => {
  const dir = tmpdir();
  const s = Store.open(dir);
  const lot = makeLot({ id: 'A', mass: 10, unit: 'kg', site: 'f1', seq: 1, createdAt: 1 });
  assert.equal(s.appendRecord(lot), true);
  assert.equal(s.appendRecord(lot), false);
  assert.equal(s.appendRecord(lot), false);
  assert.equal(s.records.length, 1);
  s.close();
});

test('unknown parent lot goes pending, then converges when lot arrives', () => {
  const dir = tmpdir();
  const s = Store.open(dir);
  s.appendRecord(makeLot({ id: 'X', mass: 10, unit: 'kg', site: 'f1', seq: s.nextSeq('f1'), createdAt: 1 }));
  const ev = makeEvent({ op: 'merge', inputs: [{ lot: 'GHOST', mass: 5 }, { lot: 'X', mass: 5 }], outputs: [{ lot: 'Y', mass: 10 }], ts: 2, site: 'f1', seq: s.nextSeq('f1') });
  s.appendRecord(ev); // must not fail
  assert.deepEqual(s.pending().lots, ['GHOST']);
  assert.equal(s.graph.lots.has('Y'), false);

  s.appendRecord(makeLot({ id: 'GHOST', mass: 5, unit: 'kg', site: 'f2', seq: s.nextSeq('f2'), createdAt: 1 }));
  assert.deepEqual(s.pending().events, []); // resolved automatically
  assert.ok(s.graph.lots.has('Y'));
  assert.equal(s.graph.remaining('GHOST'), 0);
  s.close();
});

test('pending survives restart and resolves after sync (convergence)', () => {
  const dirA = tmpdir();
  const dirB = tmpdir();
  const a = Store.open(dirA);
  a.appendRecord(makeLot({ id: 'X', mass: 10, unit: 'kg', site: 'f1', seq: a.nextSeq('f1'), createdAt: 1 }));
  const ev = makeEvent({ op: 'merge', inputs: [{ lot: 'G', mass: 5 }, { lot: 'X', mass: 5 }], outputs: [{ lot: 'Y', mass: 10 }], ts: 2, site: 'f1', seq: a.nextSeq('f1') });
  a.appendRecord(ev);
  a.close();

  // restart: pending is recomputed from the log
  const a2 = Store.open(dirA);
  assert.deepEqual(a2.pending().lots, ['G']);

  const b = seedStore(dirB, 'f2');
  b.appendRecord(makeLot({ id: 'G', mass: 5, unit: 'kg', site: 'f2', seq: b.nextSeq('f2'), createdAt: 1 }));
  syncStores(a2, b);
  assert.deepEqual(a2.pending().events, []);
  assert.ok(a2.graph.lots.has('Y'));
  assert.ok(b.graph.lots.has('Y')); // resolved event propagates
  a2.close();
  b.close();
});

test('CLI sync: pending exits 3, resolved after lot arrives', () => {
  const dirA = tmpdir();
  const dirB = tmpdir();
  assert.equal(addLot(dirA, 'f1', 'X', 10, 1).code, 0);
  assert.equal(cli(['sync', '--dir', dirA, '--with', dirB]).code, 0);

  // B records an event whose parent GHOST is unknown: pending, exit 3
  const p = addEvent(dirB, 'f2', 'merge', [['GHOST', 5], ['X', 5]], [['Y', 10]], 2);
  assert.equal(p.code, 3);
  assert.equal(p.errJson().code, 3);

  const s1 = cli(['sync', '--dir', dirA, '--with', dirB]);
  assert.equal(s1.code, 3); // both sides pending now

  assert.equal(addLot(dirA, 'f1', 'GHOST', 5, 1).code, 0);
  const s2 = cli(['sync', '--dir', dirA, '--with', dirB]);
  assert.equal(s2.code, 0, s2.stderr);

  const r = cli(['resume', '--dir', dirB]);
  assert.equal(r.code, 0, r.stderr);
  assert.equal(r.json().pending.events.length, 0);
});
