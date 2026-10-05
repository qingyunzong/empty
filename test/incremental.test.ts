import { test } from "node:test";
import { deepEqual, equal } from "node:assert/strict";
import { El, treeSize, walk } from "../src/tree.js";
import { DomIndex, indexedQuery, scanQuery } from "../src/query.js";

const SELECTORS = [
  "div",
  "*",
  ".x",
  ".x.y",
  "[data-k]",
  '[data-k="v1"]',
  "li:nth-child(2)",
  "li:nth-child(odd)",
  "li:nth-child(2n+1)",
  "li:nth-child(-n+2)",
  "ul > li",
  "div > .x",
  "div .x",
  "section div > [data-k]",
  "div, .x",
  "ul > li, li:nth-child(1)",
  ".x, .x, div",
];

function assertConsistent(root: El, index: DomIndex, ctx: string): void {
  equal(index.size, treeSize(root), `${ctx}: index size drifted from tree size`);
  for (const sel of SELECTORS) {
    deepEqual(indexedQuery(root, index, sel), scanQuery(root, sel), `${ctx}: "${sel}"`);
  }
}

test("move does not leave stale parent relations in the index", () => {
  const root = new El("section");
  const c1 = root.appendChild(new El("div", { classes: ["c1"] }));
  const c2 = root.appendChild(new El("div", { classes: ["c2"] }));
  const item = c1.appendChild(new El("span", { classes: ["x"] }));
  const index = new DomIndex(root);

  deepEqual(indexedQuery(root, index, ".c1 > .x"), [item]);
  deepEqual(indexedQuery(root, index, ".c1 .x"), [item]);

  c2.appendChild(item); // move

  deepEqual(indexedQuery(root, index, ".c1 > .x"), [], "old parent must not match after move");
  deepEqual(indexedQuery(root, index, ".c1 .x"), [], "old ancestor must not match after move");
  deepEqual(indexedQuery(root, index, ".c2 > .x"), [item], "new parent must match after move");
  deepEqual(indexedQuery(root, index, ".c2 .x"), [item]);
  assertConsistent(root, index, "after move");
  index.dispose();
});

test("delete removes subtree from index; nth-child shifts", () => {
  const root = new El("ul");
  const li1 = root.appendChild(new El("li", { classes: ["x"] }));
  const li2 = root.appendChild(new El("li"));
  const li3 = root.appendChild(new El("li", { classes: ["x"] }));
  const index = new DomIndex(root);

  deepEqual(indexedQuery(root, index, "li:nth-child(3)"), [li3]);
  li1.remove();
  deepEqual(indexedQuery(root, index, "li:nth-child(1)"), [li2], "nth-child re-evaluated after delete");
  deepEqual(indexedQuery(root, index, "li:nth-child(2)"), [li3]);
  deepEqual(indexedQuery(root, index, ".x"), [li3], "deleted node gone from class index");
  li3.remove();
  deepEqual(indexedQuery(root, index, ".x"), []);
  assertConsistent(root, index, "after deletes");
  index.dispose();
});

test("insert into a moved subtree is indexed under the new parent", () => {
  const root = new El("section");
  const a = root.appendChild(new El("div", { classes: ["a"] }));
  const b = root.appendChild(new El("div", { classes: ["b"] }));
  const sub = a.appendChild(new El("ul"));
  sub.appendChild(new El("li", { classes: ["x"] }));
  const index = new DomIndex(root);

  b.appendChild(sub); // move whole subtree
  const fresh = sub.appendChild(new El("li", { classes: ["x"] })); // insert after move

  deepEqual(indexedQuery(root, index, ".a li"), [], "no stale ancestor .a");
  deepEqual(indexedQuery(root, index, ".b li.x").length, 2);
  deepEqual(indexedQuery(root, index, ".b > ul > li:nth-child(2)"), [fresh]);
  assertConsistent(root, index, "after subtree move + insert");
  index.dispose();
});

test("attribute and class changes re-index the element", () => {
  const root = new El("div");
  const child = root.appendChild(new El("span"));
  const index = new DomIndex(root);

  child.setAttr("data-k", "v1");
  child.addClass("x");
  deepEqual(indexedQuery(root, index, '[data-k="v1"]'), [child]);
  deepEqual(indexedQuery(root, index, ".x"), [child]);
  child.removeAttr("data-k");
  child.removeClass("x");
  deepEqual(indexedQuery(root, index, "[data-k]"), []);
  deepEqual(indexedQuery(root, index, ".x"), []);
  assertConsistent(root, index, "after attr/class changes");
  index.dispose();
});

/** Deterministic PRNG (mulberry32). */
function rng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const TAGS = ["div", "span", "ul", "li", "p", "section"];
const CLASSES = ["x", "y", "z"];
const ATTRS = ["data-k", "data-m", "title"];

function randomEl(rand: () => number): El {
  const el = new El(TAGS[Math.floor(rand() * TAGS.length)]!);
  for (const c of CLASSES) if (rand() < 0.3) el.addClass(c);
  for (const a of ATTRS) if (rand() < 0.3) el.setAttr(a, `v${1 + Math.floor(rand() * 3)}`);
  return el;
}

test("fuzz: indexed query matches full scan across random insert/move/delete", () => {
  for (const seed of [1, 7, 42, 1337, 20261005]) {
    const rand = rng(seed);
    const root = new El("section");
    const index = new DomIndex(root);
    const live: El[] = [root];

    const pickNode = (): El => live[Math.floor(rand() * live.length)]!;
    const pickParent = (): El => {
      for (;;) {
        const n = pickNode();
        if (live.includes(n)) return n;
      }
    };

    for (let step = 0; step < 400; step++) {
      const op = rand();
      if (op < 0.35 || live.length < 3) {
        // insert
        const parent = pickParent();
        const el = randomEl(rand);
        parent.insertAt(el, Math.floor(rand() * (parent.children.length + 1)));
        live.push(el);
      } else if (op < 0.7) {
        // move
        const node = pickNode();
        if (node === root) continue;
        const parent = pickParent();
        if (parent === node || isDescendant(parent, node)) continue;
        parent.insertAt(node, Math.floor(rand() * (parent.children.length + 1)));
      } else if (op < 0.9) {
        // delete
        const node = pickNode();
        if (node === root) continue;
        const removed = new Set(walk(node));
        node.remove();
        for (let i = live.length - 1; i >= 0; i--) {
          if (removed.has(live[i]!)) live.splice(i, 1);
        }
      } else {
        // attribute / class mutation
        const node = pickNode();
        const c = CLASSES[Math.floor(rand() * CLASSES.length)]!;
        const a = ATTRS[Math.floor(rand() * ATTRS.length)]!;
        if (rand() < 0.5) {
          if (rand() < 0.5) node.addClass(c);
          else node.removeClass(c);
        } else if (rand() < 0.5) {
          node.setAttr(a, `v${1 + Math.floor(rand() * 3)}`);
        } else {
          node.removeAttr(a);
        }
      }
      assertConsistent(root, index, `seed=${seed} step=${step}`);
    }
    index.dispose();
  }
});

function isDescendant(node: El, maybeAncestor: El): boolean {
  let cur = node.parent;
  while (cur !== null) {
    if (cur === maybeAncestor) return true;
    cur = cur.parent;
  }
  return false;
}
