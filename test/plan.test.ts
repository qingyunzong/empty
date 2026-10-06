import { test } from "node:test";
import * as assert from "node:assert/strict";
import { Document, ElementNode, compile, naiveQuery } from "../src/index.js";
import {
  mulberry32,
  buildRandomTree,
  randomSelector,
  assertSameNodes,
  ids,
  pick,
} from "./helpers.js";

interface Fixture {
  doc: Document;
  byId: Map<string, ElementNode>;
}

// html
//   body
//     div#a[data-x=1]
//       span#s1[data-y=2]
//       p#p1
//         span#s2
//     div#b
//       span#s3[data-x=1]
//     ul#u
//       li#l1
//       li#l2[data-x=1]
function fixture(): Fixture {
  const doc = new Document();
  const byId = new Map<string, ElementNode>();
  const add = (parent: ElementNode, tag: string, id: string, attrs: Record<string, string> = {}) => {
    const node = doc.createElement(tag, { ...attrs, id });
    doc.appendChild(parent, node);
    byId.set(id, node);
    return node;
  };
  doc.root.attributes.set("id", "html");
  byId.set("html", doc.root);
  const body = add(doc.root, "body", "body");
  const a = add(body, "div", "a", { "data-x": "1" });
  add(a, "span", "s1", { "data-y": "2" });
  const p1 = add(a, "p", "p1");
  add(p1, "span", "s2");
  const b = add(body, "div", "b");
  add(b, "span", "s3", { "data-x": "1" });
  const u = add(body, "ul", "u");
  add(u, "li", "l1");
  add(u, "li", "l2", { "data-x": "1" });
  doc.flush();
  return { doc, byId };
}

function expectIds(f: Fixture, selector: string, scopeId: string, expected: string[]): void {
  const scope = f.byId.get(scopeId);
  assert.ok(scope, `scope ${scopeId}`);
  const plan = compile(selector);
  assert.deepEqual(ids(plan.query(scope)), expected, `plan ${selector} @ ${scopeId}`);
  assert.deepEqual(ids(naiveQuery(scope, selector)), expected, `naive ${selector} @ ${scopeId}`);
}

test("tag, attribute and compound matching", () => {
  const f = fixture();
  expectIds(f, "span", "html", ["s1", "s2", "s3"]);
  expectIds(f, "[data-x=1]", "html", ["a", "s3", "l2"]);
  expectIds(f, "[data-y]", "html", ["s1"]);
  expectIds(f, "span[data-x=1]", "html", ["s3"]);
  expectIds(f, "*", "html", ["html", "body", "a", "s1", "p1", "s2", "b", "s3", "u", "l1", "l2"]);
});

test("child and descendant combinators", () => {
  const f = fixture();
  expectIds(f, "div span", "html", ["s1", "s2", "s3"]);
  expectIds(f, "div > span", "html", ["s1", "s3"]);
  expectIds(f, "div p span", "html", ["s2"]);
  expectIds(f, "div > p > span", "html", ["s2"]);
  expectIds(f, "div[data-x=1] span", "html", ["s1", "s2"]);
  expectIds(f, "ul > li[data-x=1]", "html", ["l2"]);
  expectIds(f, "body > div > p span", "html", ["s2"]);
});

test("unions are deduplicated and returned in document order", () => {
  const f = fixture();
  expectIds(f, "span, li", "html", ["s1", "s2", "s3", "l1", "l2"]);
  expectIds(f, "li, span", "html", ["s1", "s2", "s3", "l1", "l2"]);
  expectIds(f, "div, div", "html", ["a", "b"]);
  expectIds(f, "span, [data-y=2], div span", "html", ["s1", "s2", "s3"]);
  expectIds(f, "[data-x=1], span[data-x=1]", "html", ["a", "s3", "l2"]);
});

test("scope root is eligible but ancestor matching cannot cross it", () => {
  const f = fixture();
  // scope root itself can be a match
  expectIds(f, "div", "a", ["a"]);
  expectIds(f, "div span", "a", ["s1", "s2"]);
  // 'body' and 'html' are outside the scope: chains may not cross the root
  expectIds(f, "body span", "a", []);
  expectIds(f, "html div", "a", []);
  expectIds(f, "body > div", "a", []);
  expectIds(f, "html > body div span", "a", []);
  // scoped to an inner node, results stay inside
  expectIds(f, "span", "b", ["s3"]);
  expectIds(f, "div span", "b", ["s3"]);
});

test("plans are reusable across scopes", () => {
  const f = fixture();
  const plan = compile("div span");
  assert.deepEqual(ids(plan.query(f.byId.get("html")!)), ["s1", "s2", "s3"]);
  assert.deepEqual(ids(plan.query(f.byId.get("a")!)), ["s1", "s2"]);
  assert.deepEqual(ids(plan.query(f.byId.get("b")!)), ["s3"]);
  assert.deepEqual(ids(plan.query(f.byId.get("u")!)), []);
});

test("fuzz: compiled plan matches naive reference on random trees and selectors", () => {
  const rand = mulberry32(0xC0FFEE);
  for (let iter = 0; iter < 300; iter++) {
    const doc = new Document();
    const all = buildRandomTree(doc, rand, 25);
    doc.flush();
    const selector = randomSelector(rand);
    const scope = pick(rand, all);
    const plan = compile(selector);
    assertSameNodes(
      plan.query(scope),
      naiveQuery(scope, selector),
      `iter ${iter} selector=${JSON.stringify(selector)} scope=${scope.getAttribute("id")}`,
    );
  }
});
