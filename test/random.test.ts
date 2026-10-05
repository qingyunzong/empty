// Randomized cross-checks:
//   cached incremental ConstraintStore
//   vs. the no-cache unifier (unifyAll, recomputed from scratch)
//   vs. small-term expansion (fully expanded frozen terms).
// All runs are seeded and deterministic.

import { test } from "node:test";
import assert from "node:assert/strict";

import { Type, tvar, equalType, typeToString, collectVars } from "../src/types.js";
import {
  ConstraintStore,
  UnifyError,
  unifyAll,
  expand,
  type NamedConstraint,
  type Subst,
} from "../src/unify.js";
import { Rng, randomConstraints, type RawConstraint } from "./gen.js";

const VAR_POOL = 6;
const TRIALS = 300;

function toNamed(raw: readonly RawConstraint[]): NamedConstraint[] {
  return raw.map((c, i) => Object.freeze({ id: i + 1, name: c.name, lhs: c.lhs, rhs: c.rhs }));
}

/** Every variable and constraint endpoint must expand identically. */
function assertSameExpansion(
  cached: ConstraintStore,
  oracle: Subst,
  raw: readonly RawConstraint[],
  ctx: string,
): void {
  for (let v = 0; v < VAR_POOL; v++) {
    const a = cached.expand(tvar(v));
    const b = expand(tvar(v), oracle);
    assert.ok(
      equalType(a, b),
      `${ctx}: t${v} expands differently: ${typeToString(a)} vs ${typeToString(b)}`,
    );
  }
  for (const c of raw) {
    for (const side of [c.lhs, c.rhs]) {
      const a = cached.expand(side);
      const b = expand(side, oracle);
      assert.ok(
        equalType(a, b),
        `${ctx}: ${typeToString(side)} expands differently: ${typeToString(a)} vs ${typeToString(b)}`,
      );
    }
  }
}

test("cached store matches no-cache unifier on random constraints", () => {
  let failures = 0;
  for (let seed = 0; seed < TRIALS; seed++) {
    const rng = new Rng(seed);
    const raw = randomConstraints(rng, 4 + rng.int(7), VAR_POOL);
    const store = new ConstraintStore();
    const accepted: RawConstraint[] = [];
    let failedAt: number | null = null;

    for (const c of raw) {
      const r = store.add(c.name, c.lhs, c.rhs);
      if (r.ok) {
        accepted.push(c);
      } else {
        failedAt = accepted.length;
        failures++;

        // The no-cache oracle must fail on the same prefix.
        let oracleError: UnifyError | null = null;
        try {
          unifyAll(toNamed([...accepted, c]));
        } catch (e) {
          assert.ok(e instanceof UnifyError);
          oracleError = e;
        }
        assert.ok(oracleError !== null, `seed ${seed}: oracle should fail too`);

        // Conflict chain: ID-ordered, contains the new constraint, 1-minimal.
        const chain = r.conflict.constraints;
        const ids = chain.map((x) => x.id);
        assert.deepEqual(ids, [...ids].sort((x, y) => x - y), `seed ${seed}: chain sorted`);
        assert.ok(ids.includes(r.id), `seed ${seed}: chain includes failing constraint`);
        // The chain still fails, with the reason recorded on the chain itself.
        // (The minimized subset may legitimately fail differently than the
        // full prefix, so the reason is checked against the chain, not the
        // whole set.)
        let chainError: UnifyError | null = null;
        try {
          unifyAll(chain);
        } catch (e) {
          assert.ok(e instanceof UnifyError);
          chainError = e;
        }
        assert.ok(chainError !== null, `seed ${seed}: chain still fails`);
        assert.equal(
          r.conflict.reason.kind,
          chainError.info.kind,
          `seed ${seed}: chain reason matches recomputation`,
        );
        for (const link of chain) {
          unifyAll(chain.filter((x) => x.id !== link.id)); // must not throw
        }
        break;
      }
    }

    // Whatever was accepted must agree with the no-cache oracle, checked via
    // full small-term expansion of every variable and constraint side.
    const oracle = unifyAll(toNamed(accepted));
    assertSameExpansion(store, oracle, accepted, `seed ${seed}`);
    if (failedAt !== null) {
      assert.equal(store.size, failedAt, `seed ${seed}: failed add kept store intact`);
    }
  }
  assert.ok(failures > 0, "expected some random batches to conflict");
});

test("random revokes keep cached store in sync with no-cache oracle", () => {
  for (let seed = 1000; seed < 1000 + TRIALS; seed++) {
    const rng = new Rng(seed);
    const raw = randomConstraints(rng, 5 + rng.int(6), VAR_POOL);
    const store = new ConstraintStore();
    const live: RawConstraint[] = [];
    for (const c of raw) {
      if (store.add(c.name, c.lhs, c.rhs).ok) live.push(c);
    }
    // Revoke a random subset, one at a time, cross-checking after each step.
    const shuffled = [...live];
    for (let i = shuffled.length - 1; i > 0; i--) {
      const j = rng.int(i + 1);
      const tmp = shuffled[i]!;
      shuffled[i] = shuffled[j]!;
      shuffled[j] = tmp;
    }
    const toRevoke = shuffled.slice(0, rng.int(shuffled.length + 1));
    for (const victim of toRevoke) {
      assert.ok(store.revoke(victim.name), `seed ${seed}: revoke ${victim.name}`);
      live.splice(live.indexOf(victim), 1);
      const oracle = unifyAll(toNamed(live));
      assertSameExpansion(store, oracle, live, `seed ${seed} after revoking ${victim.name}`);
    }
    // Revoking an unknown name is a no-op.
    assert.ok(!store.revoke("no-such-constraint"));
  }
});

test("small-term expansion is idempotent and snapshot-stable", () => {
  for (let seed = 2000; seed < 2000 + 100; seed++) {
    const rng = new Rng(seed);
    const raw = randomConstraints(rng, 4 + rng.int(5), VAR_POOL);
    const store = new ConstraintStore();
    for (const c of raw) {
      if (!store.add(c.name, c.lhs, c.rhs).ok) break;
    }
    const snap = store.snapshot();
    for (let v = 0; v < VAR_POOL; v++) {
      const once = snap.expand(tvar(v));
      const twice = snap.expand(once);
      assert.ok(equalType(once, twice), `seed ${seed}: expansion idempotent for t${v}`);
      // Expanded terms contain only unbound variables.
      for (const id of collectVars(once)) {
        assert.ok(!snap.has(id), `seed ${seed}: t${id} unbound after expansion`);
      }
    }
    // Adding more constraints must not change the old snapshot.
    const before = new Map([...snap.entries()].map(([k, v]) => [k, typeToString(v)]));
    store.add("late", tvar(0), tvar(1));
    for (const [k, s] of before) {
      assert.equal(typeToString(snap.get(k) as Type), s, `seed ${seed}: snapshot stable`);
    }
  }
});
