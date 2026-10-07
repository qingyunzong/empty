import { test } from "node:test";
import assert from "node:assert";
import {
  table, scan, filter, project, join, execute, multisetEqual,
  and, eq, gt, col, lit, isNull, isNotNull,
  filterPushdownIntoJoin, outerToInnerJoin,
  projectEliminationIdentity, projectEliminationNested,
  joinCommutativity, leftRightJoinSwap,
  optimize, Plan,
} from "../src/index.js";

const R = table(["a", "b"], [[1, 10], [2, null], [null, 30], [2, null]]);
const S = table(["c", "d"], [[1, 100], [null, 200], [3, 300]]);

test("filter pushdown into inner join fires with certificate", () => {
  const q = filter(and(gt(col("a"), lit(0)), gt(col("d"), lit(50))),
    join("inner", eq(col("a"), col("c")), scan(R), scan(S)));
  const r = filterPushdownIntoJoin(q);
  assert.ok(r);
  assert.equal(r.certificate.rule, "filter-pushdown-into-join");
  assert.ok(r.certificate.preconditions.some((p) => p.name === "P1-column-subset"));
  assert.ok(r.certificate.before.includes("Filter"));
  assert.ok(multisetEqual(execute(q), execute(r.plan)));
});

test("REFUSAL: non-null-rejecting predicate is not pushed into null-supplying side of left join", () => {
  // d IS NULL on the right (null-supplying) side of a LEFT join must stay above.
  const q = filter(isNull(col("d")),
    join("left", eq(col("a"), col("c")), scan(R), scan(S)));
  const r = filterPushdownIntoJoin(q);
  assert.equal(r, null); // nothing pushable -> rule refuses entirely
});

test("null-rejecting predicate on null-supplying side: pushed AND join strengthened to inner", () => {
  const q = filter(gt(col("d"), lit(50)),
    join("left", eq(col("a"), col("c")), scan(R), scan(S)));
  const r = filterPushdownIntoJoin(q);
  assert.ok(r);
  // P0: the null-rejecting conjunct forces LEFT -> INNER, otherwise preserved
  // rows (NULL d) discarded by the original filter would reappear.
  assert.ok(r.certificate.preconditions.some((p) => p.name === "P0-null-rejecting-strengthens-kind"));
  assert.ok(r.certificate.after.includes("Join[inner]"));
  assert.ok(multisetEqual(execute(q), execute(r.plan)));
});

test("outer-to-inner: null-rejecting filter on null-supplying side collapses LEFT to INNER", () => {
  const q = filter(gt(col("d"), lit(50)),
    join("left", eq(col("a"), col("c")), scan(R), scan(S)));
  const r = outerToInnerJoin(q);
  assert.ok(r);
  assert.equal(r.certificate.rule, "outer-to-inner-join");
  assert.ok(r.certificate.after.includes("Join[inner]"));
  assert.ok(multisetEqual(execute(q), execute(r.plan)));
});

test("REFUSAL: left join without null-rejecting filter stays outer", () => {
  const q = filter(isNull(col("d")),
    join("left", eq(col("a"), col("c")), scan(R), scan(S)));
  assert.equal(outerToInnerJoin(q), null);
});

test("project elimination: identity and nested", () => {
  const id = project(["a", "b"], scan(R));
  const r1 = projectEliminationIdentity(id);
  assert.ok(r1);
  assert.equal(r1.plan.op, "scan");
  const nested = project(["a"], project(["a", "b"], scan(R)));
  const r2 = projectEliminationNested(nested);
  assert.ok(r2);
  assert.equal(r2.plan.op, "project");
  assert.ok(multisetEqual(execute(nested), execute(r2.plan)));
  // refusal: outer needs a column the inner dropped
  const bad = project(["a", "b"], project(["a"], scan(R)));
  assert.equal(projectEliminationNested(bad), null);
});

test("join commutativity only for inner joins; left/right mirror swap", () => {
  const inner = join("inner", eq(col("a"), col("c")), scan(R), scan(S));
  const rc = joinCommutativity(inner);
  assert.ok(rc);
  assert.ok(multisetEqual(execute(inner), execute(rc.plan)));
  const left = join("left", eq(col("a"), col("c")), scan(R), scan(S));
  assert.equal(joinCommutativity(left), null); // refuses on outer join
  const rs = leftRightJoinSwap(left);
  assert.ok(rs);
  assert.ok(rs.certificate.after.includes("Join[right]"));
  assert.ok(multisetEqual(execute(left), execute(rs.plan)));
});

test("optimizer emits a certificate chain and preserves results", () => {
  const q: Plan = project(["a", "b", "c", "d"],
    filter(and(gt(col("a"), lit(0)), isNotNull(col("d"))),
      join("left", eq(col("a"), col("c")), scan(R), scan(S))));
  const { plan, certificates } = optimize(q);
  assert.ok(certificates.length >= 2); // outer-to-inner + pushdown (+ maybe project elim)
  for (const c of certificates) {
    assert.ok(c.rule.length > 0);
    assert.ok(c.preconditions.length > 0);
    assert.ok(c.before.length > 0 && c.after.length > 0);
  }
  assert.ok(multisetEqual(execute(q), execute(plan)));
});
