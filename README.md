# type-infer

A small type-inference core in TypeScript (Node.js built-ins only, zero runtime
dependencies):

- **Type language**: type variables (`tvar`), functions (`tfun`), lists (`tlist`).
- **Unified occurs check**: a single `occursIn` guards every variable binding.
- **Named, undoable constraints**: `add(name, l, r)` / `undo(name)` / `undoById(id)`;
  state is rebuilt from the remaining constraints, so undo is always exact.
- **Minimal ID-ordered conflict chains**: a rejected constraint yields a
  1-minimal failing subset of constraints, ids sorted ascending
  (`minimizeConflict`, greedy deletion verified against the oracle in tests).
- **Immutable snapshots**: `snapshot()` deep-resolves and deep-freezes all
  bindings; later adds/undos never affect it, and mutation attempts throw.

## Layout

- `src/types.ts` — type AST, structural equality, pretty-printing, deep freeze.
- `src/unifier.ts` — `Unifier` (path-compressing substitution), conflict chains, snapshots.
- `src/oracle.ts` — naive no-cache reference unifier (association-list subst,
  full term rewriting) plus small-term expansion checker.
- `src/random.ts` — seeded mulberry32 PRNG and random type/constraint generators.
- `test/` — unit tests and randomized cross-checks (`node:test`).
- `types/node-shim.d.ts` — minimal ambient declarations for `node:test` /
  `node:assert/strict` (offline sandbox, no `@types/node`).

## Test

```sh
npm test    # tsc -p tsconfig.json && node --test "dist/test/*.test.js"
```

The randomized suites generate small terms (≤5 vars, depth ≤3) and check, per
seed: accept/reject agreement with the no-cache oracle, structural equality of
both sides of every constraint after small-term expansion, agreement of the
main unifier's resolved variables with oracle expansion, 1-minimality and
id-ordering of conflict chains, consistency after random undo sequences, and
snapshot immutability under add/undo churn.

## Actual results (recorded 2026-10-05)

Environment: Node.js v22.22.1, TypeScript 7.0.2, Linux x64.

```
$ npm test
# Subtest: dist/test/randomized.test.js
ok 1 - dist/test/randomized.test.js   (duration_ms ≈ 540)
# Subtest: dist/test/unifier.test.js
ok 2 - dist/test/unifier.test.js      (duration_ms ≈ 430)
# tests 2   # pass 2   # fail 0
```

Random cross-check distribution over 400 seeds (spec: 5 vars, depth ≤ 3,
1–8 constraints per sequence): **58 fully accepted, 342 rejected** — every
rejection confirmed by the oracle, every conflict chain verified minimal
(chain fails; dropping any single member unifies again) and id-ordered.
