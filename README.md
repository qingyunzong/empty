# crdt-list

A convergent (CRDT-style) ordered list library in TypeScript, using only
Node.js built-in modules (no runtime dependencies).

## Properties

- **Stable element IDs** — `replica#counter`, never reused.
- **Moves are versioned position records** — `{ version, frac }`: a
  Lamport-style operation ID plus a dense fractional index key
  (`src/fraction.ts`). Only the highest-version record wins.
- **Deletes never free IDs** — deletion appends a tombstone; the ID stays
  reserved (`has(id)` remains true).
- **Old moves cannot resurrect causally-later-deleted elements** — each
  delete records the move versions it observed (`seenMoves`, its causal
  frontier). An element is dead iff its winning position record is in some
  tombstone's frontier. A move *concurrent* with a delete is not in the
  frontier, so it wins and the element stays live.
- **Concurrent moves resolve by operation ID** — highest `(clock, replica)`
  wins, identically on every replica.
- **Out-of-order merge converges** — `apply`/`merge` accept ops in any
  order, are idempotent, and every replica applying the same op set
  materializes the same list, with each element appearing at most once.

## API

```ts
import { CrdtList } from "./src/list.js";

const a = new CrdtList<string>("A");
const { id, op } = a.insert("x", 0);   // -> { id, op }
const mv = a.move(id, 3);              // -> MoveOp (versioned position record)
const del = a.delete(id);              // -> DeleteOp (carries causal frontier)

const b = new CrdtList<string>("B");
b.merge([op, mv, del]);                // any order, idempotent
b.entries();                           // [{ id, value }] in list order
```

Ops are plain JSON (`InsertOp | MoveOp | DeleteOp`); ship them over any
transport. `list.ops()` returns every op the replica has issued or accepted.

## Test

```
npm test    # tsc -p tsconfig.json && node --test "dist/test/*.test.js"
```

Recorded actual result (Node v22.22.1, tsc 7.0.2, 2026-10-05):

```
ok 1 - fraction: keys stay strictly between bounds
ok 2 - stable IDs: deletes never free IDs and IDs are never reused
ok 3 - moves are versioned: an old move arriving late does not reorder
ok 4 - an old move cannot resurrect a causally-later-deleted element
ok 5 - a move concurrent with a delete wins and keeps the element live
ok 6 - concurrent moves are resolved by operation ID on every replica
ok 7 - re-applying an op is idempotent
ok 8 - out-of-order shuffle merge converges; each element appears at most once
ok 9 - move before insert arrives (out-of-order) still converges
# tests 9
# pass 9
# fail 0
```

Note: `@types/node` is unavailable in this offline environment, so
`test/node-shims.d.ts` provides minimal ambient declarations for
`node:test` / `node:assert/strict`.
