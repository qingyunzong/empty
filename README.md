# crdt-list

A convergent (CRDT) list library in TypeScript using only Node.js built-in
modules — no runtime dependencies, no install step required.

## Guarantees

- **Stable element IDs** — every element is identified by the ID of the insert
  op that created it (`replica:counter`). IDs survive moves and are never
  reused.
- **Versioned position records** — a move is a position record
  `{ key, version }` stamped with the operation ID that produced it. An older
  record can never override a newer one.
- **Deletes don't release IDs** — deletion writes a tombstone; the ID stays
  known to the replica forever (`has(id)` / `isDeleted(id)`).
- **No resurrection by old moves** — a delete carries the deleting replica's
  causal context (a version vector). A move causally dominated by the delete
  is dropped and can never resurrect or reposition the element.
- **Concurrent moves pick one winner by operation ID** — concurrent position
  records are totally ordered by `(counter, replica)`; the greatest wins on
  every replica.
- **Order-independent merge** — `apply`/`applyAll` are idempotent and
  commutative. Ops arriving out of order (moves/deletes before the insert)
  are buffered and folded in when the insert arrives, so any delivery order
  converges to the same state, and each element appears at most once.

## API sketch

```ts
import { ListCRDT } from './src/index.js';

const a = new ListCRDT<string>('A');
const id = a.insert('x');      // stable ElementId
a.insert('y');
a.move(id, 1);                 // versioned position record
a.delete(id);                  // tombstone; ID never released

const b = new ListCRDT<string>('B');
b.applyAll(a.getLocalOps());   // merge; any order, duplicates are fine
b.entries();                   // [{ id, value }] in list order
```

Positions use fractional base-36 keys (`keyBetween`); ties between identical
keys are broken by element ID, keeping ordering deterministic.

## Layout

- `src/opid.ts` — operation IDs, version vectors, causal domination
- `src/position.ts` — fractional position keys
- `src/list.ts` — the `ListCRDT` (state, op application, merge rules)
- `test/` — `node:test` suites
- `types/node-shims.d.ts` — minimal `node:test` / `node:assert` typings
  (the sandbox has no network access, so `@types/node` is not installed)

## Test

```
npm test        # tsc build + node --test
```

Environment: Node.js v22.22.1, TypeScript 7.0.2 (global `tsc`), npm 9.2.0.

### Actual result (recorded 2026-10-05)

```
> crdt-list@0.1.0 test
> npm run build && node --test "dist/test/*.test.js"

# Subtest: dist/test/list.test.js
ok 1 - dist/test/list.test.js
# Subtest: dist/test/position.test.js
ok 2 - dist/test/position.test.js
1..2
# tests 2
# suites 0
# pass 2
# fail 0
# cancelled 0
# skipped 0
# todo 0
```

Individual cases (all passing):

```
ok 1 - IDs survive moves and are never reused after delete
ok 2 - delete/move of unknown or deleted elements throw
ok 3 - an older move record cannot override a newer one
ok 4 - applying the same op twice is a no-op
ok 5 - an old move cannot resurrect a causally-later-deleted element
ok 6 - concurrent move and delete converge: delete wins, no resurrection
ok 7 - resolved deterministically by operation ID on every replica
ok 8 - random op streams merged in shuffled order converge; each element appears at most once
ok 9 - unbounded keys are ordered
ok 10 - result is strictly between bounds, including adjacent digits
ok 11 - repeated midpoint insertion stays strictly ordered
```

The acceptance test (#8) generates 120 random insert/move/delete ops across
4 replicas, then merges the full op set into 4 fresh replicas, each in a
different shuffled order with 25 duplicated ops, plus one replica in causal
order. All replicas converge to identical materialized lists and identical
tombstone sets, and every element appears at most once.
