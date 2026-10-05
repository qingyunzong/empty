import { test } from "node:test";
import assert from "node:assert/strict";

import { Type, tvar, tfun, tlist, equalType, typeToString, collectVars } from "../src/types.js";
import {
  ConstraintStore,
  UnifyError,
  unify,
  unifyAll,
  expand,
  occurs,
  minimizeConflict,
  equalUnder,
  type NamedConstraint,
} from "../src/unify.js";

function frozenDeeply(t: Type): boolean {
  if (!Object.isFrozen(t)) return false;
  switch (t.kind) {
    case "var":
      return true;
    case "fun":
      return frozenDeeply(t.param) && frozenDeeply(t.result);
    case "list":
      return frozenDeeply(t.elem);
  }
}

test("unify binds variables to functions and lists", () => {
  const subst = new Map();
  unify(tvar(0), tfun(tvar(1), tlist(tvar(2))), subst);
  unify(tvar(1), tlist(tvar(3)), subst);
  const expanded = expand(tvar(0), subst);
  assert.equal(typeToString(expanded), "([t3] -> [t2])");
  assert.ok(frozenDeeply(expanded));
});

test("unified occurs check rejects cyclic bindings", () => {
  const subst = new Map();
  assert.throws(() => unify(tvar(0), tlist(tvar(0)), subst));
  try {
    unify(tvar(0), tlist(tvar(0)), subst);
    assert.fail("should have thrown");
  } catch (e) {
    assert.ok(e instanceof UnifyError);
    assert.equal(e.info.kind, "occurs");
    assert.equal(e.info.variable, 0);
  }
  // occurs() itself, exercised directly and through indirection
  const s2 = new Map();
  unify(tvar(1), tfun(tvar(2), tvar(3)), s2);
  assert.ok(occurs(2, tvar(1), s2));
  assert.ok(!occurs(4, tvar(1), s2));
});

test("constructor mismatch between fun and list fails", () => {
  const subst = new Map();
  try {
    unify(tfun(tvar(0), tvar(0)), tlist(tvar(1)), subst);
    assert.fail("should have thrown");
  } catch (e) {
    assert.ok(e instanceof UnifyError);
    assert.equal(e.info.kind, "mismatch");
  }
});

test("failed add leaves store unchanged and reports minimal ID-ordered chain", () => {
  const store = new ConstraintStore();
  assert.ok(store.add("c1", tvar(0), tlist(tvar(1))).ok);
  assert.ok(store.add("c2", tvar(1), tfun(tvar(2), tvar(2))).ok);
  const r3 = store.add("c3", tvar(0), tfun(tvar(3), tvar(3)));
  assert.ok(!r3.ok);
  if (r3.ok) return;
  // Only c1 and c3 are needed for the conflict; c2 is noise.
  const ids = r3.conflict.constraints.map((c) => c.id);
  assert.deepEqual(ids, [1, 3]);
  assert.equal(r3.conflict.reason.kind, "mismatch");
  // The failing constraint is always part of its chain.
  assert.ok(ids.includes(r3.id));
  // Store state is untouched by the failed add.
  assert.equal(store.size, 2);
  assert.equal(typeToString(store.expand(tvar(0))), "[(t2 -> t2)]");
});

test("conflict chain is 1-minimal and sorted by id", () => {
  const store = new ConstraintStore();
  store.add("a", tvar(0), tlist(tvar(1)));
  store.add("b", tvar(2), tlist(tvar(3)));
  store.add("c", tvar(1), tfun(tvar(4), tvar(4)));
  store.add("d", tvar(3), tvar(4));
  const r = store.add("e", tvar(0), tvar(2));
  assert.ok(!r.ok);
  if (r.ok) return;
  const chain = r.conflict.constraints;
  const ids = chain.map((c) => c.id);
  const sorted = [...ids].sort((x, y) => x - y);
  assert.deepEqual(ids, sorted);
  // 1-minimality: dropping any single constraint makes the set solvable.
  for (const c of chain) {
    const rest = chain.filter((x) => x.id !== c.id);
    unifyAll(rest); // must not throw
  }
  // The chain itself still fails, with the same reason kind.
  assert.throws(() => unifyAll(chain));
});

test("named constraints are revocable and solvability is restored", () => {
  const store = new ConstraintStore();
  store.add("keep", tvar(0), tlist(tvar(1)));
  const bad = store.add("bad", tvar(0), tfun(tvar(2), tvar(2)));
  assert.ok(!bad.ok);
  // Revoking a name that was never registered (failed add) returns false.
  assert.ok(!store.revoke("bad"));
  // Revoke the constraint that blocks "bad", then it succeeds.
  assert.ok(store.revoke("keep"));
  assert.equal(store.size, 1 - 1);
  const ok = store.add("bad", tvar(0), tfun(tvar(2), tvar(2)));
  assert.ok(ok.ok);
  assert.equal(typeToString(store.expand(tvar(0))), "(t2 -> t2)");
});

test("duplicate constraint names are rejected", () => {
  const store = new ConstraintStore();
  store.add("x", tvar(0), tvar(1));
  assert.throws(() => store.add("x", tvar(0), tvar(1)));
});

test("old snapshots are immutable and unaffected by later adds", () => {
  const store = new ConstraintStore();
  store.add("c1", tvar(0), tlist(tvar(1)));
  const snap1 = store.snapshot();
  store.add("c2", tvar(1), tfun(tvar(2), tvar(2)));
  const snap2 = store.snapshot();

  assert.equal(snap1.size, 1);
  assert.equal(snap2.size, 2);
  // snap1 still sees the old binding, unchanged.
  assert.equal(typeToString(snap1.expand(tvar(0))), "[t1]");
  assert.equal(typeToString(snap2.expand(tvar(0))), "[(t2 -> t2)]");

  // Everything reachable from a snapshot is frozen.
  assert.ok(Object.isFrozen(snap1));
  const bound = snap1.get(0);
  assert.ok(bound !== undefined && frozenDeeply(bound));

  // Mutation attempts throw in strict mode (ES modules are strict).
  assert.throws(() => {
    (snap1 as unknown as { size: number }).size = 99;
  });
  assert.throws(() => {
    (bound as { kind: string }).kind = "var";
  });
  assert.equal(snap1.size, 1);
});

test("type constructors produce deeply frozen terms", () => {
  const t = tfun(tvar(0), tlist(tfun(tvar(1), tvar(2))));
  assert.ok(frozenDeeply(t));
  assert.throws(() => {
    (t as { kind: string }).kind = "list";
  });
  assert.deepEqual(collectVars(t), [0, 1, 2]);
});

test("equalUnder compares fully expanded forms", () => {
  const subst = new Map();
  unify(tvar(0), tlist(tvar(1)), subst);
  unify(tvar(1), tfun(tvar(2), tvar(2)), subst);
  assert.ok(equalUnder(tvar(0), tlist(tlist(tfun(tvar(2), tvar(2)))), subst) === false);
  assert.ok(equalUnder(tvar(0), tvar(0), subst));
  assert.ok(equalType(expand(tvar(0), subst), expand(tvar(0), subst)));
});

test("minimizeConflict throws on solvable input", () => {
  const cs: NamedConstraint[] = [
    Object.freeze({ id: 1, name: "a", lhs: tvar(0), rhs: tvar(1) }),
  ];
  assert.throws(() => minimizeConflict(cs));
});

test("unifying a variable with itself (distinct nodes, same id) is a no-op", () => {
  const subst = new Map();
  unify(tvar(4), tvar(4), subst); // must not trip the occurs check
  assert.equal(subst.size, 0);
  const store = new ConstraintStore();
  assert.ok(store.add("self", tvar(4), tvar(4)).ok);
});
