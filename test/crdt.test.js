import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Store, NegativeCountError } from '../src/crdt.js';

function countEvent(id, terminal, key, delta) {
  return { type: 'count', id, terminal, key, delta };
}

function downEvent(id, start, end) {
  return { type: 'down', id, start, end };
}

function undoEvent(id, target) {
  return { type: 'undo', id, target };
}

function sampleEvents() {
  return [
    countEvent('c1', 'A', 'produced', 100),
    countEvent('c2', 'B', 'produced', 80),
    countEvent('c3', 'A', 'rejected', 5),
    countEvent('c4', 'B', 'rejected', 3),
    downEvent('d1', '2026-10-05T08:00:00Z', '2026-10-05T08:30:00Z'),
    downEvent('d2', '2026-10-05T08:15:00Z', '2026-10-05T09:00:00Z'),
    downEvent('d3', '2026-10-05T10:00:00Z', '2026-10-05T10:10:00Z'),
    undoEvent('u1', 'd3'),
  ];
}

test('merge is idempotent', () => {
  const a = new Store(sampleEvents());
  const once = new Store().merge(a);
  const twice = new Store().merge(a).merge(a);
  assert.ok(once.equals(twice));
});

test('merge is commutative', () => {
  const events = sampleEvents();
  const a = new Store(events.slice(0, 4));
  const b = new Store(events.slice(4));
  assert.ok(new Store().merge(a).merge(b).equals(new Store().merge(b).merge(a)));
});

test('merge is associative', () => {
  const events = sampleEvents();
  const a = new Store(events.slice(0, 3));
  const b = new Store(events.slice(3, 5));
  const c = new Store(events.slice(5));
  const left = new Store().merge(new Store().merge(a).merge(b)).merge(c);
  const right = new Store().merge(a).merge(new Store().merge(b).merge(c));
  assert.ok(left.equals(right));
});

test('duplicate event ids are absorbed (idempotent re-delivery)', () => {
  const store = new Store([countEvent('c1', 'A', 'produced', 100)]);
  store.add(countEvent('c1', 'A', 'produced', 100));
  assert.equal(store.produced(), 100);
});

test('negative count delta throws NegativeCountError', () => {
  assert.throws(() => new Store([countEvent('bad', 'A', 'produced', -1)]), NegativeCountError);
});

test('G-Counter totals are per-terminal sums; PN-Counter is produced minus rejected', () => {
  const store = new Store([
    countEvent('c1', 'A', 'produced', 100),
    countEvent('c2', 'A', 'produced', 50),
    countEvent('c3', 'B', 'produced', 80),
    countEvent('c4', 'A', 'rejected', 5),
  ]);
  assert.equal(store.produced(), 230);
  assert.equal(store.rejected(), 5);
  assert.equal(store.netCount(), 225);
  assert.deepEqual([...store.gCounter('produced').entries()].sort(), [['A', 150], ['B', 80]]);
});

test('overlapping downtimes merge into disjoint coverage', () => {
  const store = new Store([
    downEvent('d1', '2026-10-05T08:00:00Z', '2026-10-05T08:30:00Z'),
    downEvent('d2', '2026-10-05T08:15:00Z', '2026-10-05T09:00:00Z'),
    downEvent('d3', '2026-10-05T10:00:00Z', '2026-10-05T10:10:00Z'),
  ]);
  const merged = store.mergedDowntimeIntervals();
  assert.equal(merged.length, 2);
  assert.equal(merged[0].end - merged[0].start, 60 * 60000);
  assert.equal(merged[1].end - merged[1].start, 10 * 60000);
});

test('anti-entropy digest: identical sets hash equally, missing ids are reported', () => {
  const events = sampleEvents();
  const full = new Store(events);
  const partial = new Store(events.slice(0, 5));
  assert.equal(full.digest().hash, new Store(events).digest().hash);
  assert.notEqual(full.digest().hash, partial.digest().hash);
  assert.deepEqual(full.missingFrom(partial), full.ids().slice(5));
  // after shipping the missing events, digests converge
  const repaired = new Store(events.slice(0, 5));
  for (const id of full.missingFrom(partial)) repaired.add(full.events.get(id));
  assert.equal(repaired.digest().hash, full.digest().hash);
});

function* permutations(items) {
  if (items.length <= 1) {
    yield items;
    return;
  }
  for (let i = 0; i < items.length; i += 1) {
    const rest = [...items.slice(0, i), ...items.slice(i + 1)];
    for (const perm of permutations(rest)) {
      yield [items[i], ...perm];
    }
  }
}

test('acceptance 4: all merge orders of <=10 events converge to the same state', () => {
  const events = sampleEvents(); // 8 events

  // Exhaustive: every sequential merge order for up to 7 events.
  for (let n = 1; n <= 7; n += 1) {
    const subset = events.slice(0, n);
    const reference = new Store(subset).toJSONL();
    let checked = 0;
    for (const order of permutations(subset)) {
      const store = new Store();
      for (const event of order) store.merge(new Store([event]));
      assert.equal(store.toJSONL(), reference, `order ${order.map((e) => e.id)} diverged`);
      checked += 1;
    }
    assert.equal(checked, factorial(n));
  }

  // All 2^8 binary shardings of the full 8-event set, merged in both orders.
  const reference = new Store(events).toJSONL();
  for (let mask = 0; mask < 2 ** events.length; mask += 1) {
    const left = new Store(events.filter((_, i) => mask & (1 << i)));
    const right = new Store(events.filter((_, i) => !(mask & (1 << i))));
    assert.equal(new Store().merge(left).merge(right).toJSONL(), reference);
    assert.equal(new Store().merge(right).merge(left).toJSONL(), reference);
  }

  // 10 events: all 2^10 shardings plus pairwise-tournament merge trees.
  const ten = [...events, countEvent('c5', 'A', 'produced', 20), undoEvent('u2', 'd1')];
  const ref10 = new Store(ten).toJSONL();
  for (let mask = 0; mask < 2 ** ten.length; mask += 1) {
    const left = new Store(ten.filter((_, i) => mask & (1 << i)));
    const right = new Store(ten.filter((_, i) => !(mask & (1 << i))));
    assert.equal(new Store().merge(left).merge(right).toJSONL(), ref10);
  }
  // tournament reduction (different associativity bracketing)
  let level = ten.map((e) => new Store([e]));
  while (level.length > 1) {
    const next = [];
    for (let i = 0; i < level.length; i += 2) {
      next.push(i + 1 < level.length ? new Store().merge(level[i]).merge(level[i + 1]) : level[i]);
    }
    level = next;
  }
  assert.equal(level[0].toJSONL(), ref10);
});

function factorial(n) {
  return n <= 1 ? 1 : n * factorial(n - 1);
}
