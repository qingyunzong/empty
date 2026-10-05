import { test } from "node:test";
import { deepEqual } from "node:assert/strict";
import { El } from "../src/tree.js";
import { DomIndex, indexedQuery, scanQuery } from "../src/query.js";

/**
 * Fixed fixture:
 *   section
 *   ├── div.a[data-k=v1]
 *   │   ├── ul
 *   │   │   ├── li.x        (1)
 *   │   │   ├── li.y[data-k=v2] (2)
 *   │   │   └── li.x        (3)
 *   │   └── p.a
 *   ├── div.b
 *   │   └── span.x
 *   └── p[data-k=v1]
 */
function build() {
  const root = new El("section");
  const div1 = root.appendChild(new El("div", { classes: ["a"], attrs: { "data-k": "v1" } }));
  const ul = div1.appendChild(new El("ul"));
  const li1 = ul.appendChild(new El("li", { classes: ["x"] }));
  const li2 = ul.appendChild(new El("li", { classes: ["y"], attrs: { "data-k": "v2" } }));
  const li3 = ul.appendChild(new El("li", { classes: ["x"] }));
  const p1 = div1.appendChild(new El("p", { classes: ["a"] }));
  const div2 = root.appendChild(new El("div", { classes: ["b"] }));
  const span = div2.appendChild(new El("span", { classes: ["x"] }));
  const p2 = root.appendChild(new El("p", { attrs: { "data-k": "v1" } }));
  return { root, div1, ul, li1, li2, li3, p1, div2, span, p2 };
}

const cases: Array<[string, (f: ReturnType<typeof build>) => El[]]> = [
  ["div", (f) => [f.div1, f.div2]],
  ["*", (f) => [f.root, f.div1, f.ul, f.li1, f.li2, f.li3, f.p1, f.div2, f.span, f.p2]],
  [".x", (f) => [f.li1, f.li3, f.span]],
  [".a", (f) => [f.div1, f.p1]],
  ["li.x", (f) => [f.li1, f.li3]],
  ["[data-k]", (f) => [f.div1, f.li2, f.p2]],
  ['[data-k="v1"]', (f) => [f.div1, f.p2]],
  ["[data-k=v2]", (f) => [f.li2]],
  ["section > div", (f) => [f.div1, f.div2]],
  ["div > ul", (f) => [f.ul]],
  ["section > li", () => []],
  ["div li", (f) => [f.li1, f.li2, f.li3]],
  ["section .x", (f) => [f.li1, f.li3, f.span]],
  ["div.a > p", (f) => [f.p1]],
  ["li:nth-child(1)", (f) => [f.li1]],
  ["li:nth-child(2)", (f) => [f.li2]],
  ["li:nth-child(odd)", (f) => [f.li1, f.li3]],
  ["li:nth-child(even)", (f) => [f.li2]],
  ["li:nth-child(2n+1)", (f) => [f.li1, f.li3]],
  ["li:nth-child(-n+2)", (f) => [f.li1, f.li2]],
  ["ul > li:nth-child(3)", (f) => [f.li3]],
  // selector lists: dedupe + document order
  [".a, .x", (f) => [f.div1, f.li1, f.li3, f.p1, f.span]],
  ["li.x, li.x", (f) => [f.li1, f.li3]],
  [".x, li", (f) => [f.li1, f.li2, f.li3, f.span]],
  ["p, div, li:nth-child(2)", (f) => [f.div1, f.li2, f.p1, f.div2, f.p2]],
];

test("scanQuery returns expected results", () => {
  const f = build();
  for (const [selector, expected] of cases) {
    deepEqual(scanQuery(f.root, selector), expected(f), `scan "${selector}"`);
  }
});

test("indexedQuery matches scanQuery and expected results", () => {
  const f = build();
  const index = new DomIndex(f.root);
  for (const [selector, expected] of cases) {
    deepEqual(indexedQuery(f.root, index, selector), expected(f), `indexed "${selector}"`);
    deepEqual(
      indexedQuery(f.root, index, selector),
      scanQuery(f.root, selector),
      `indexed vs scan "${selector}"`,
    );
  }
  index.dispose();
});
