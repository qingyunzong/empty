import { test } from "node:test";
import assert from "node:assert/strict";
import { Unifier, minimizeConflict, type Constraint } from "../src/unifier.js";
import { tvar, tfun, tlist, showType, typeEquals } from "../src/types.js";

test("unifies variables, functions and lists", () => {
  const u = new Unifier();
  // f : t0 -> [t1] unified with [t2] -> t3
  const r1 = u.add("c1", tfun(tvar(0), tlist(tvar(1))), tfun(tlist(tvar(2)), tvar(3)));
  assert.equal(r1.ok, true);
  assert.equal(showType(u.resolve(tvar(0))), "[t2]");
  assert.equal(showType(u.resolve(tvar(3))), "[t1]");
});

test("unified occurs check rejects cyclic bindings", () => {
  const u = new Unifier();
  const r = u.add("bad", tvar(0), tlist(tvar(0)));
  assert.equal(r.ok, false);
  if (!r.ok) assert.equal(r.conflict.reason, "occurs");
  // Failed constraint must not pollute state.
  assert.equal(u.constraintCount(), 0);
  const ok = u.add("good", tvar(0), tlist(tvar(1)));
  assert.equal(ok.ok, true);
  assert.equal(showType(u.resolve(tvar(0))), "[t1]");
});

test("shape mismatch between fun and list is reported", () => {
  const u = new Unifier();
  const r = u.add("bad", tfun(tvar(0), tvar(0)), tlist(tvar(1)));
  assert.equal(r.ok, false);
  if (!r.ok) assert.equal(r.conflict.reason, "shape-mismatch");
});

test("named constraints are undoable and state is rebuilt", () => {
  const u = new Unifier();
  u.add("keep", tvar(0), tlist(tvar(1)));
  u.add("temp", tvar(1), tlist(tvar(2)));
  assert.equal(showType(u.resolve(tvar(0))), "[[t2]]");
  const removed = u.undo("temp");
  assert.deepEqual(removed, [2]);
  assert.equal(showType(u.resolve(tvar(0))), "[t1]");
  assert.equal(showType(u.resolve(tvar(1))), "t1");
  // undo of unknown name is a no-op
  assert.deepEqual(u.undo("nope"), []);
});

test("undoById removes a single constraint", () => {
  const u = new Unifier();
  const r1 = u.add("a", tvar(0), tlist(tvar(1)));
  const r2 = u.add("b", tvar(1), tlist(tvar(2)));
  if (!r1.ok || !r2.ok) assert.fail("expected both constraints to be accepted");
  assert.equal(u.undoById(r2.id), true);
  assert.equal(showType(u.resolve(tvar(0))), "[t1]");
  assert.equal(u.undoById(999), false);
});

test("failure yields a minimal conflict chain in id order", () => {
  const u = new Unifier();
  // c1: t0 = [t1]; c2: t1 = t2 -> t2; c3 (fails): t2 = t0
  // t0 = [t1] = [t2 -> t2], so t2 = t0 forces t2 = [t2 -> t2] -> occurs failure.
  assert.ok(u.add("c1", tvar(0), tlist(tvar(1))).ok);
  assert.ok(u.add("c2", tvar(1), tfun(tvar(2), tvar(2))).ok);
  const r = u.add("c3", tvar(2), tvar(0));
  assert.equal(r.ok, false);
  if (r.ok) return;
  assert.deepEqual(r.conflict.constraintIds, [1, 2, 3]);
  assert.equal(r.conflict.reason, "occurs");
  // 1-minimality: dropping any element of the chain unifies again.
  const all: Constraint[] = [
    { id: 1, name: "c1", left: tvar(0), right: tlist(tvar(1)) },
    { id: 2, name: "c2", left: tvar(1), right: tfun(tvar(2), tvar(2)) },
    { id: 3, name: "c3", left: tvar(2), right: tvar(0) },
  ];
  for (const drop of r.conflict.constraintIds) {
    const rest = all.filter((c) => c.id !== drop);
    const probe = new Unifier();
    for (const c of rest) assert.equal(probe.add(c.name, c.left, c.right).ok, true);
  }
});

test("minimizeConflict drops irrelevant constraints", () => {
  const all: Constraint[] = [
    { id: 1, name: "noise", left: tvar(9), right: tlist(tvar(8)) },
    { id: 2, name: "a", left: tvar(0), right: tlist(tvar(0)) },
    { id: 3, name: "more-noise", left: tvar(7), right: tvar(6) },
  ];
  const chain = minimizeConflict(all);
  assert.deepEqual(chain.constraintIds, [2]);
});

test("snapshots are immutable and unaffected by later changes", () => {
  const u = new Unifier();
  u.add("c1", tvar(0), tlist(tvar(1)));
  const snap = u.snapshot();
  const before = snap.resolve(tvar(0));
  assert.equal(showType(before), "[t1]");

  // Later mutations must not leak into the snapshot.
  u.add("c2", tvar(1), tlist(tvar(2)));
  u.undo("c1");
  assert.equal(showType(snap.resolve(tvar(0))), "[t1]");
  assert.equal(showType(snap.bindings().get(0)!), "[t1]");

  // The snapshot is deeply frozen.
  assert.ok(Object.isFrozen(before));
  if (before.kind === "list") assert.ok(Object.isFrozen(before.elem));
  assert.throws(() => {
    (before as { kind: string }).kind = "var";
  }, TypeError);
  assert.equal(showType(snap.resolve(tvar(0))), "[t1]");
});

test("types resolved through snapshot equal live resolution at capture time", () => {
  const u = new Unifier();
  u.add("c1", tvar(0), tfun(tvar(1), tlist(tvar(2))));
  u.add("c2", tvar(2), tvar(1));
  const snap = u.snapshot();
  assert.ok(typeEquals(snap.resolve(tvar(0)), u.resolve(tvar(0))));
});
