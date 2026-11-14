// @ts-nocheck
import assert from "node:assert/strict";
import test from "node:test";
import {
  YamlGraphError,
  createYamlGraph,
  findNodeByAnchor,
  parseYamlDocuments,
  parseYamlGraph,
  toJS,
  walkYaml,
} from "../index.ts";

test("anchors and aliases preserve shared nodes", () => {
  const root = parseYamlGraph(`
base: &base
  a: 1
  nested: [x, y]
one: *base
two: *base
`);
  const base = root.get("base");
  assert.equal(root.get("one"), base);
  assert.equal(root.get("two"), base);
  assert.equal(findNodeByAnchor(root, "base"), base);
  assert.equal(base?.anchor, "base");
});

test("merge keys follow YAML precedence and retain provenance", () => {
  const root = parseYamlGraph(`
first: &first {a: 1, b: 1}
second: &second {b: 2, c: 2}
service:
  <<: [*first, *second]
  c: 3
`);
  const service = root.get("service");
  assert.equal(service?.get("a")?.value, 1);
  assert.equal(service?.get("b")?.value, 1);
  assert.equal(service?.get("c")?.value, 3);
  assert.deepEqual(
    service?.entries.map((entry) => entry.keyText),
    ["c", "a", "b"],
  );
  const a = service?.getEntry("a");
  assert.equal(a?.sourceKind, "merge");
  assert.equal(a?.origin.kind, "merge");
  assert.equal(a?.merge?.aliasAnchor, "first");
  assert.equal(a?.origin.anchor, "first");
  assert.equal(a?.origin.targetPath, "$.service.a");
  assert.equal(a?.origin.mergedFrom?.path, "$.first.a");
  const c = service?.getEntry("c");
  assert.equal(c?.explicit, true);
  assert.equal(c?.provenance.length, 2);
  assert.equal(c?.provenance[1]?.kind, "merge");
  assert.equal(c?.provenance[1]?.overridden, true);
});

test("multiple merge keys and same-line root anchors keep source anchors", () => {
  const root = parseYamlGraph(`
&root
first: &first {a: 1}
second: &second {b: 2}
target:
  <<: *first
  <<: *second
`);
  assert.equal(root.anchor, "root");
  const target = root.get("target");
  assert.equal(target?.getEntry("a")?.merge?.aliasAnchor, "first");
  assert.equal(target?.getEntry("b")?.merge?.aliasAnchor, "second");
});

test("duplicate key strategies are deterministic", () => {
  const source = "a: 1\na: 2\n";
  assert.throws(
    () => parseYamlGraph(source),
    (error) =>
      error instanceof YamlGraphError &&
      error.code === "DUPLICATE_KEY" &&
      error.path === "$.a",
  );
  const first = parseYamlGraph(source, { duplicateKeys: "first" });
  assert.equal(first.get("a")?.value, 1);
  assert.equal(first.getEntry("a")?.provenance[1]?.overridden, true);
  const last = parseYamlGraph(source, { duplicateKeys: "last-wins" });
  assert.equal(last.get("a")?.value, 2);
  assert.equal(last.getEntry("a")?.provenance[1]?.overridden, true);
});

test("cyclic aliases report the alias path", () => {
  assert.throws(
    () => parseYamlGraph("a: &a\n  self: *a\n"),
    (error) =>
      error instanceof YamlGraphError &&
      error.code === "ALIAS_CYCLE" &&
      error.path === "$.a.self" &&
      /\$\.a\.self -> \$\.a/.test(error.message),
  );

  const graph = parseYamlGraph("a: &a\n  - *a\n", { allowCycles: true });
  assert.equal(graph.get("a")?.items[0], graph.get("a"));
  assert.equal(graph.cycles.length, 1);
  assert.equal(graph.cycles[0].path, "$.a[0]");
  const value = toJS(graph);
  assert.equal(value.a, value.a[0]);
});

test("alias expansion budget stops a billion-laughs style document", () => {
  let source = "a: &a [x,x,x,x,x,x,x,x,x,x]\n";
  for (let i = 0; i < 6; i += 1) {
    const name = String.fromCharCode(98 + i);
    const previous = String.fromCharCode(97 + i);
    source += `${name}: &${name} [${Array(10).fill(`*${previous}`).join(",")}]\n`;
  }
  assert.throws(
    () => parseYamlGraph(source, { maxAliasExpansions: 500 }),
    (error) =>
      error instanceof YamlGraphError &&
      error.code === "ALIAS_BUDGET" &&
      typeof error.path === "string" &&
      error.path.startsWith("$."),
  );
});

test("block and flow YAML syntax is represented as typed nodes", () => {
  const root = parseYamlGraph(`
list:
  - one
  - name: two
    value: 2
  - - nested
flow: {a: 1, b: [x, y], "c d": true}
literal: |
  hello
  world
folded: >
  hello
  world
quoted: "a\\tb"
empty:
nulls: [null, ~]
`);
  const list = root.get("list");
  assert.equal(list?.kind, "sequence");
  assert.equal(list?.items[1]?.kind, "mapping");
  assert.equal(list?.items[2]?.kind, "sequence");
  assert.deepEqual(toJS(root.get("flow")), {
    a: 1,
    b: ["x", "y"],
    "c d": true,
  });
  assert.equal(root.get("literal")?.value, "hello\nworld\n");
  assert.equal(root.get("folded")?.value, "hello world\n");
  assert.equal(root.get("quoted")?.value, "a\tb");
  assert.equal(root.get("empty")?.value, null);
  assert.deepEqual(toJS(root.get("nulls")), [null, null]);
});

test("multiple documents and graph wrapper are available", () => {
  const documents = parseYamlDocuments("---\na: 1\n---\n- x\n- y\n");
  assert.equal(documents.length, 2);
  assert.equal(documents[1]?.root.kind, "sequence");

  const graph = createYamlGraph("a: &a {x: 1}\nb: *a\n");
  assert.equal(graph.getNode("$.b"), graph.getNode("$.a"));
  assert.deepEqual(graph.toJS(), { a: { x: 1 }, b: { x: 1 } });
  let visited = 0;
  walkYaml(graph.root, () => {
    visited += 1;
  });
  assert.equal(visited, 3);
});
