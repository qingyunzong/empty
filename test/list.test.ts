import { describe, test } from 'node:test';
import { deepEqual, equal, notEqual, ok, throws } from 'node:assert/strict';
import { ListCRDT, Op } from '../src/index.js';

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function shuffle<T>(items: T[], rand: () => number): T[] {
  const out = [...items];
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [out[i], out[j]] = [out[j]!, out[i]!];
  }
  return out;
}

describe('stable element IDs', () => {
  test('IDs survive moves and are never reused after delete', () => {
    const list = new ListCRDT<string>('R1');
    const idA = list.insert('a');
    const idB = list.insert('b');
    const idC = list.insert('c');
    equal(new Set([idA, idB, idC]).size, 3);

    list.move(idA, 2);
    equal(list.get(idA), 'a');
    deepEqual(list.toArray(), ['b', 'c', 'a']);

    list.delete(idB);
    equal(list.get(idB), undefined);
    ok(list.has(idB), 'tombstone retained');
    ok(list.isDeleted(idB));
    ok(list.knownIds().includes(idB), 'ID not released');

    const idD = list.insert('d');
    notEqual(idD, idB);
    ok(!list.knownIds().slice(0, -1).includes(idD));
  });

  test('delete/move of unknown or deleted elements throw', () => {
    const list = new ListCRDT<string>('R1');
    const id = list.insert('x');
    list.delete(id);
    throws(() => list.delete(id));
    throws(() => list.move(id, 0));
    throws(() => list.delete('nope:1'));
  });
});

describe('versioned position records', () => {
  test('an older move record cannot override a newer one', () => {
    const list = new ListCRDT<string>('R1');
    const x = list.insert('x');
    list.insert('y');
    list.insert('z');

    list.move(x, 2); // -> [y, z, x]
    const oldMove = list.getLocalOps().at(-1)!;
    equal(oldMove.kind, 'move');
    deepEqual(list.toArray(), ['y', 'z', 'x']);

    list.move(x, 0); // -> [x, y, z]
    deepEqual(list.toArray(), ['x', 'y', 'z']);

    list.apply(oldMove); // stale record replayed: must not revert
    deepEqual(list.toArray(), ['x', 'y', 'z']);
  });

  test('applying the same op twice is a no-op', () => {
    const a = new ListCRDT<string>('R1');
    const x = a.insert('x');
    a.insert('y');
    a.move(x, 1);
    const ops = a.getLocalOps();

    const b = new ListCRDT<string>('R2');
    b.applyAll(ops);
    b.applyAll(ops); // duplicate delivery
    deepEqual(b.entries(), a.entries());
  });
});

describe('delete semantics', () => {
  test('an old move cannot resurrect a causally-later-deleted element', () => {
    const a = new ListCRDT<string>('A');
    const x = a.insert('x'); // A:1
    a.insert('y'); // A:2
    a.move(x, 1); // A:3 — the "old move"
    const oldMove = a.getLocalOps().at(-1)!;
    a.delete(x); // A:4 — causally after the move
    const del = a.getLocalOps().at(-1)!;
    const inserts = a.getLocalOps().slice(0, 2);

    // B receives the delete BEFORE the old move (out of order).
    const b = new ListCRDT<string>('B');
    b.applyAll([...inserts, del, oldMove]);
    ok(b.isDeleted(x));
    deepEqual(b.toArray(), ['y']);

    // C receives ops in causal order. Both must converge.
    const c = new ListCRDT<string>('C');
    c.applyAll(a.getLocalOps());
    deepEqual(b.entries(), c.entries());
    deepEqual(b.knownIds().sort(), c.knownIds().sort());
  });

  test('concurrent move and delete converge: delete wins, no resurrection', () => {
    const a = new ListCRDT<string>('A');
    const x = a.insert('x');
    a.insert('y');
    const setup = a.getLocalOps();

    const b = new ListCRDT<string>('B');
    b.applyAll(setup);
    const c = new ListCRDT<string>('C');
    c.applyAll(setup);

    b.delete(x); // concurrent with...
    c.move(x, 0); // ...a move from C

    b.applyAll(c.getLocalOps());
    c.applyAll(b.getLocalOps());

    ok(b.isDeleted(x));
    ok(c.isDeleted(x));
    deepEqual(b.entries(), c.entries());
    deepEqual(b.toArray(), ['y']);
  });
});

describe('concurrent moves', () => {
  test('resolved deterministically by operation ID on every replica', () => {
    const setup = new ListCRDT<string>('S');
    const x = setup.insert('x');
    setup.insert('y');
    setup.insert('z');
    const base = setup.getLocalOps();

    const b = new ListCRDT<string>('B');
    b.applyAll(base);
    const c = new ListCRDT<string>('C');
    c.applyAll(base);

    b.move(x, 2); // B:1 — move x to the end
    c.move(x, 0); // C:1 — concurrent: move x to the front
    const bOps = b.getLocalOps();
    const cOps = c.getLocalOps();

    // Cross-deliver in opposite orders.
    b.applyAll(cOps);
    c.applyAll(bOps);

    // Same counter -> replica ID breaks the tie: 'C' > 'B', so C's move wins.
    deepEqual(b.toArray(), ['x', 'y', 'z']);
    deepEqual(b.entries(), c.entries());

    // A third replica applying the moves in either order agrees.
    for (const ops of [[...bOps, ...cOps], [...cOps, ...bOps]]) {
      const d = new ListCRDT<string>('D');
      d.applyAll(base);
      d.applyAll(ops);
      deepEqual(d.entries(), b.entries());
    }
  });
});

describe('out-of-order merge acceptance', () => {
  test('random op streams merged in shuffled order converge; each element appears at most once', () => {
    const rand = mulberry32(42);
    const sources = ['A', 'B', 'C', 'D'].map((id) => new ListCRDT<string>(id));
    let valueCounter = 0;

    for (let step = 0; step < 120; step++) {
      const replica = sources[Math.floor(rand() * sources.length)]!;
      const entries = replica.entries();
      const roll = rand();
      if (entries.length === 0 || roll < 0.45) {
        replica.insert(`v${valueCounter++}`, Math.floor(rand() * (entries.length + 1)));
      } else if (roll < 0.8) {
        const target = entries[Math.floor(rand() * entries.length)]!;
        replica.move(target.id, Math.floor(rand() * entries.length));
      } else {
        const target = entries[Math.floor(rand() * entries.length)]!;
        replica.delete(target.id);
      }
    }

    const allOps: Op<string>[] = sources.flatMap((r) => r.getLocalOps());
    ok(allOps.length >= 120, 'ops were generated');

    // Merge the full op set into fresh replicas, each in a different shuffled
    // order, with some ops duplicated to exercise idempotency.
    const merged: ListCRDT<string>[] = [];
    for (let d = 0; d < 4; d++) {
      const replica = new ListCRDT<string>(`M${d}`);
      const rnd = mulberry32(1000 + d);
      const shuffled = shuffle(allOps, rnd);
      replica.applyAll([...shuffled, ...shuffled.slice(0, 25)]);
      merged.push(replica);
    }

    const expected = merged[0]!.entries();
    for (const replica of merged) {
      deepEqual(replica.entries(), expected);
      deepEqual(replica.knownIds().sort(), merged[0]!.knownIds().sort());
    }

    const ids = expected.map((e) => e.id);
    equal(new Set(ids).size, ids.length, 'each element appears at most once');

    // A replica applying ops in causal (generation) order agrees too.
    const causal = new ListCRDT<string>('Z');
    causal.applyAll(allOps);
    deepEqual(causal.entries(), expected);
  });
});
