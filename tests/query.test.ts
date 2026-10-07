import { test } from "node:test";
import assert from "node:assert/strict";
import { createElement, appendChild, type El } from "../src/tree.js";
import { parseSelectorList } from "../src/selector.js";
import { queryScan } from "../src/query.js";

function tags(els: El[]): string {
  return els.map((el) => `${el.tag}#${el.uid}`).join(" ");
}

function uids(els: El[]): number[] {
  return els.map((el) => el.uid);
}

// Builds this tree:
// root
//  +- div.a [data-k="1"]
//  |   +- p.b
//  |   +- span.a
//  |   +- p.b [data-k="2"]
//  +- ul
//  |   +- li  +- li.a  +- li  +- li  +- li.a
//  +- div [data-k="2"]
//      +- p.b
function fixture() {
  const root = createElement("#root");
  const div1 = createElement("div", { classes: ["a"], attrs: { "data-k": "1" } });
  const p1 = createElement("p", { classes: ["b"] });
  const span = createElement("span", { classes: ["a"] });
  const p2 = createElement("p", { classes: ["b"], attrs: { "data-k": "2" } });
  const ul = createElement("ul");
  const lis = [
    createElement("li"),
    createElement("li", { classes: ["a"] }),
    createElement("li"),
    createElement("li"),
    createElement("li", { classes: ["a"] }),
  ];
  const div2 = createElement("div", { attrs: { "data-k": "2" } });
  const p3 = createElement("p", { classes: ["b"] });
  appendChild(root, div1);
  appendChild(div1, p1);
  appendChild(div1, span);
  appendChild(div1, p2);
  appendChild(root, ul);
  for (const li of lis) appendChild(ul, li);
  appendChild(root, div2);
  appendChild(div2, p3);
  return { root, div1, p1, span, p2, ul, lis, div2, p3 };
}

const q = (root: El, s: string): El[] => queryScan(root, parseSelectorList(s));

test("tag, class and attribute selectors", () => {
  const f = fixture();
  assert.deepEqual(uids(q(f.root, "p")), uids([f.p1, f.p2, f.p3]));
  assert.deepEqual(uids(q(f.root, ".a")), uids([f.div1, f.span, f.lis[1]!, f.lis[4]!]));
  assert.deepEqual(uids(q(f.root, "[data-k]")), uids([f.div1, f.p2, f.div2]));
  assert.deepEqual(uids(q(f.root, '[data-k="2"]')), uids([f.p2, f.div2]));
  assert.deepEqual(uids(q(f.root, "p.b[data-k]")), uids([f.p2]));
  assert.deepEqual(uids(q(f.root, '[data-k="9"]')), []);
});

test("descendant and child combinators", () => {
  const f = fixture();
  assert.deepEqual(uids(q(f.root, "div p")), uids([f.p1, f.p2, f.p3]));
  assert.deepEqual(uids(q(f.root, "div > p")), uids([f.p1, f.p2, f.p3]));
  assert.deepEqual(uids(q(f.root, "ul > li.a")), uids([f.lis[1]!, f.lis[4]!]));
  assert.deepEqual(uids(q(f.root, "ul p")), []);
  assert.deepEqual(uids(q(f.root, "div .a")), uids([f.span]));
  assert.deepEqual(uids(q(f.root, "div > .a")), uids([f.span]));
});

test("nth-child positions among siblings", () => {
  const f = fixture();
  const L = f.lis;
  assert.deepEqual(uids(q(f.root, "li:nth-child(1)")), uids([L[0]!]));
  assert.deepEqual(uids(q(f.root, "li:nth-child(odd)")), uids([L[0]!, L[2]!, L[4]!]));
  assert.deepEqual(uids(q(f.root, "li:nth-child(even)")), uids([L[1]!, L[3]!]));
  assert.deepEqual(uids(q(f.root, "li:nth-child(2n+1)")), uids([L[0]!, L[2]!, L[4]!]));
  assert.deepEqual(uids(q(f.root, "li:nth-child(-n+2)")), uids([L[0]!, L[1]!]));
  assert.deepEqual(uids(q(f.root, "li:nth-child(n+4)")), uids([L[3]!, L[4]!]));
  assert.deepEqual(uids(q(f.root, "li.a:nth-child(2)")), uids([L[1]!]));
  assert.deepEqual(uids(q(f.root, "p:nth-child(3)")), uids([f.p2]));
});

test("selector list deduplicates and keeps tree order", () => {
  const f = fixture();
  const result = q(f.root, ".a, div, [data-k]");
  const seen = new Set(result);
  assert.equal(seen.size, result.length, "no duplicates");
  assert.deepEqual(uids(result), uids([f.div1, f.span, f.p2, f.lis[1]!, f.lis[4]!, f.div2]));
  const reversed = q(f.root, "[data-k], div, .a");
  assert.deepEqual(uids(reversed), uids(result), "order follows the tree, not the list");
});

test("nth-child never matches the parentless root", () => {
  const f = fixture();
  const firsts = q(f.root, "*:nth-child(1)");
  assert.ok(!firsts.includes(f.root));
  assert.deepEqual(uids(firsts), uids([f.div1, f.p1, f.lis[0]!, f.p3]));
});

test("fixture sanity: tags render as expected", () => {
  const f = fixture();
  assert.match(tags([f.div1, f.p1]), /^div#\d+ p#\d+$/);
});
