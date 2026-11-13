import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { Catalog, Expr, RelNode } from "../index.js";
import {
  AmbiguousColumnError,
  UnknownColumnError,
  UnknownTableError,
  analyzeLineage,
} from "../index.js";

const catalog: Catalog = {
  tables: {
    users: ["id", "name", "age"],
    orders: ["oid", "user_id", "amount", "ts"],
    accounts: ["id", "balance"],
  },
};

const col = (name: string, qualifier?: string): Expr => ({
  kind: "column",
  name,
  qualifier,
});

const scan = (table: string, alias?: string): RelNode => ({
  kind: "scan",
  table,
  alias,
});

const project = (input: RelNode, items: { expr: Expr; alias?: string }[]): RelNode => ({
  kind: "project",
  items,
  input,
});

const byName = (lineage: ReturnType<typeof analyzeLineage>) =>
  new Map(lineage.map((c) => [c.name, c]));

describe("projection", () => {
  it("tracks sources and transform path through aliases and functions", () => {
    const ast = project(scan("users"), [
      { expr: { kind: "func", name: "upper", args: [col("name")] }, alias: "uname" },
      {
        expr: { kind: "binary", op: "+", left: col("age"), right: { kind: "literal", value: 1 } },
        alias: "next_age",
      },
    ]);
    const m = byName(analyzeLineage(ast, catalog));
    assert.deepEqual(m.get("uname"), {
      name: "uname",
      sources: [{ table: "users", column: "name" }],
      path: ["func:upper", "project", "alias:uname"],
    });
    assert.deepEqual(m.get("next_age"), {
      name: "next_age",
      sources: [{ table: "users", column: "age" }],
      path: ["op:+", "project", "alias:next_age"],
    });
  });

  it("expands star by input schema generation", () => {
    const derived: RelNode = {
      kind: "project",
      input: scan("users"),
      items: [
        { expr: col("id") },
        { expr: col("name"), alias: "username" },
      ],
      alias: "u",
    };
    const ast = project(derived, [{ expr: { kind: "star" } }]);
    const lineage = analyzeLineage(ast, catalog);
    assert.deepEqual(
      lineage.map((c) => c.name),
      ["id", "username"],
    );
    assert.deepEqual(lineage[1].sources, [{ table: "users", column: "name" }]);
    assert.deepEqual(lineage[1].path, ["project", "alias:username", "project"]);
  });

  it("expands qualified star for one input only", () => {
    const join: RelNode = {
      kind: "join",
      joinType: "inner",
      left: scan("users", "u"),
      right: scan("orders", "o"),
      on: { kind: "binary", op: "=", left: col("id", "u"), right: col("user_id", "o") },
    };
    const ast = project(join, [{ expr: { kind: "star", qualifier: "o" } }]);
    const lineage = analyzeLineage(ast, catalog);
    assert.deepEqual(
      lineage.map((c) => c.name),
      ["oid", "user_id", "amount", "ts"],
    );
    assert.ok(lineage.every((c) => c.sources[0].table === "orders"));
  });
});

describe("column resolution", () => {
  const join: RelNode = {
    kind: "join",
    joinType: "inner",
    left: scan("users"),
    right: scan("accounts"),
    on: { kind: "binary", op: "=", left: col("id", "users"), right: col("id", "accounts") },
  };

  it("rejects ambiguous unqualified columns instead of guessing", () => {
    const ast = project(join, [{ expr: col("id") }]);
    assert.throws(() => analyzeLineage(ast, catalog), AmbiguousColumnError);
  });

  it("resolves qualified columns unambiguously", () => {
    const ast = project(join, [{ expr: col("id", "accounts"), alias: "acct_id" }]);
    const m = byName(analyzeLineage(ast, catalog));
    assert.deepEqual(m.get("acct_id")!.sources, [{ table: "accounts", column: "id" }]);
  });

  it("rejects unknown columns and tables", () => {
    assert.throws(
      () => analyzeLineage(project(scan("users"), [{ expr: col("nope") }]), catalog),
      UnknownColumnError,
    );
    assert.throws(
      () => analyzeLineage(project(scan("ghost"), [{ expr: col("a") }]), catalog),
      UnknownTableError,
    );
  });
});

describe("join", () => {
  it("propagates lineage from both sides", () => {
    const ast = project(
      {
        kind: "join",
        joinType: "left",
        left: scan("users", "u"),
        right: scan("orders", "o"),
        on: { kind: "binary", op: "=", left: col("id", "u"), right: col("user_id", "o") },
      },
      [
        { expr: col("name", "u") },
        { expr: col("amount", "o") },
      ],
    );
    const m = byName(analyzeLineage(ast, catalog));
    assert.deepEqual(m.get("name")!.sources, [{ table: "users", column: "name" }]);
    assert.deepEqual(m.get("name")!.path, ["join:left", "project"]);
    assert.deepEqual(m.get("amount")!.sources, [{ table: "orders", column: "amount" }]);
  });
});

describe("union", () => {
  it("merges sources positionally across branches", () => {
    const ast: RelNode = {
      kind: "union",
      inputs: [
        project(scan("users"), [{ expr: col("name") }]),
        project(scan("orders"), [{ expr: col("amount"), alias: "name" }]),
      ],
    };
    const lineage = analyzeLineage(ast, catalog);
    assert.equal(lineage.length, 1);
    assert.deepEqual(lineage[0].sources, [
      { table: "orders", column: "amount" },
      { table: "users", column: "name" },
    ]);
    assert.deepEqual(lineage[0].path, ["project", "union"]);
  });
});

describe("aggregate", () => {
  it("marks group keys and aggregate functions", () => {
    const ast: RelNode = {
      kind: "aggregate",
      input: scan("orders"),
      groupBy: [{ expr: col("user_id") }],
      aggregates: [
        { expr: { kind: "func", name: "sum", args: [col("amount")] }, alias: "total" },
      ],
    };
    const m = byName(analyzeLineage(ast, catalog));
    assert.deepEqual(m.get("user_id")!.path, ["group_by"]);
    assert.deepEqual(m.get("total"), {
      name: "total",
      sources: [{ table: "orders", column: "amount" }],
      path: ["aggregate:sum"],
    });
  });
});

describe("window", () => {
  it("includes partition and order columns in sources", () => {
    const ast = project(scan("orders"), [
      {
        expr: {
          kind: "window",
          name: "row_number",
          args: [],
          partitionBy: [col("user_id")],
          orderBy: [{ expr: col("ts"), direction: "desc" }],
        },
        alias: "rn",
      },
    ]);
    const m = byName(analyzeLineage(ast, catalog));
    assert.deepEqual(m.get("rn"), {
      name: "rn",
      sources: [
        { table: "orders", column: "ts" },
        { table: "orders", column: "user_id" },
      ],
      path: ["window:row_number", "project", "alias:rn"],
    });
  });
});

describe("correlated subquery", () => {
  it("captures outer references from correlation predicates", () => {
    const inner: RelNode = {
      kind: "aggregate",
      input: {
        kind: "filter",
        input: scan("orders"),
        predicate: {
          kind: "binary",
          op: "=",
          left: col("user_id", "orders"),
          right: col("id", "users"),
        },
      },
      groupBy: [],
      aggregates: [{ expr: { kind: "func", name: "max", args: [col("amount")] } }],
    };
    const ast: RelNode = {
      kind: "project",
      input: scan("users"),
      items: [
        { expr: col("name") },
        { expr: { kind: "subquery", query: inner }, alias: "max_amt" },
      ],
    };
    const m = byName(analyzeLineage(ast, catalog));
    assert.deepEqual(m.get("max_amt")!.sources, [
      { table: "orders", column: "amount" },
      { table: "orders", column: "user_id" },
      { table: "users", column: "id" },
    ]);
    assert.deepEqual(m.get("max_amt")!.path, [
      "aggregate:max",
      "subquery:scalar",
      "project",
      "alias:max_amt",
    ]);
  });
});

describe("normalization stability", () => {
  it("is stable for commutative expression variants", () => {
    const mk = (left: Expr, right: Expr): RelNode =>
      project(scan("users"), [
        { expr: { kind: "binary", op: "+", left, right }, alias: "v" },
      ]);
    const a = analyzeLineage(mk(col("age"), col("id")), catalog);
    const b = analyzeLineage(mk(col("id"), col("age")), catalog);
    assert.deepEqual(a, b);
  });

  it("is stable for swapped inner join inputs", () => {
    const mk = (left: RelNode, right: RelNode): RelNode =>
      project(
        {
          kind: "join",
          joinType: "inner",
          left,
          right,
          on: { kind: "binary", op: "=", left: col("id", "u"), right: col("user_id", "o") },
        },
        [{ expr: col("name", "u") }, { expr: col("amount", "o") }],
      );
    const a = analyzeLineage(mk(scan("users", "u"), scan("orders", "o")), catalog);
    const b = analyzeLineage(mk(scan("orders", "o"), scan("users", "u")), catalog);
    assert.deepEqual(a, b);
  });

  it("is stable for swapped union branches", () => {
    const branchA = project(scan("users"), [{ expr: col("name") }]);
    const branchB = project(scan("orders"), [{ expr: col("amount"), alias: "name" }]);
    const a = analyzeLineage({ kind: "union", inputs: [branchA, branchB] }, catalog);
    const b = analyzeLineage({ kind: "union", inputs: [branchB, branchA] }, catalog);
    assert.deepEqual(a, b);
  });
});
