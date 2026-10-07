import { test } from "node:test";
import assert from "node:assert/strict";
import { createElement, type El } from "../src/tree.js";
import { Document } from "../src/index.js";
import { validateIndex } from "../src/validate.js";

const uids = (els: El[]): number[] => els.map((el) => el.uid);

function sample(): { doc: Document; a: El; b: El; c: El; d: El } {
  const doc = new Document();
  const a = createElement("div", { classes: ["x"] });
  const b = createElement("div", { classes: ["y"] });
  const c = createElement("span", { classes: ["z"], attrs: { "data-k": "1" } });
  const d = createElement("em");
  doc.appendChild(doc.root, a);
  doc.appendChild(doc.root, b);
  doc.appendChild(a, c);
  doc.appendChild(c, d);
  return { doc, a, b, c, d };
}

test("moving a node re-links its parent relation without stale entries", () => {
  const { doc, a, b, c } = sample();
  doc.appendChild(b, c); // move c (with child d) from a to b
  assert.equal(doc.index.parent.get(c), b);
  assert.deepEqual(doc.index.children.get(a), []);
  assert.deepEqual(doc.index.children.get(b), [c]);
  assert.deepEqual(uids(doc.query(".x > .z")), []);
  assert.deepEqual(uids(doc.query(".y > .z")), [c.uid]);
  assert.deepEqual(uids(doc.query(".y em")), [c.children[0]!.uid]);
  validateIndex(doc.root, doc.index);
});

test("removing a subtree erases every index entry for it", () => {
  const { doc, a, c, d } = sample();
  doc.removeChild(doc.root, a);
  for (const el of [a, c, d]) {
    assert.equal(doc.index.all.has(el), false, `#${el.uid} gone from all`);
    assert.equal(doc.index.parent.has(el), false, `#${el.uid} has no parent entry`);
    assert.equal(doc.index.children.has(el), false, `#${el.uid} has no children entry`);
  }
  assert.equal(doc.index.byClass.has("x"), false);
  assert.equal(doc.index.byClass.has("z"), false);
  assert.equal(doc.index.byAttr.has("data-k"), false);
  assert.deepEqual(doc.query(".z"), []);
  validateIndex(doc.root, doc.index);
});

test("re-attaching a removed subtree restores queries", () => {
  const { doc, a, b, c, d } = sample();
  doc.removeChild(doc.root, a);
  doc.appendChild(b, a); // re-attach under a different parent
  assert.equal(doc.index.parent.get(a), b);
  assert.equal(doc.index.parent.get(c), a);
  assert.deepEqual(uids(doc.query(".y > .x")), [a.uid]);
  assert.deepEqual(uids(doc.query(".y .z")), [c.uid]);
  assert.deepEqual(uids(doc.query(".y em")), [d.uid]);
  validateIndex(doc.root, doc.index);
});

test("insertBefore keeps indexed child order in sync", () => {
  const doc = new Document();
  const one = createElement("li");
  const two = createElement("li");
  const three = createElement("li");
  doc.appendChild(doc.root, one);
  doc.appendChild(doc.root, three);
  doc.insertBefore(doc.root, two, three);
  assert.deepEqual(doc.index.children.get(doc.root), [one, two, three]);
  assert.deepEqual(uids(doc.query("li:nth-child(2)")), [two.uid]);
  // move one to the end and re-check positions
  doc.appendChild(doc.root, one);
  assert.deepEqual(uids(doc.query("li:nth-child(3)")), [one.uid]);
  validateIndex(doc.root, doc.index);
});

test("indexed query matches full scan on a static tree", () => {
  const { doc } = sample();
  for (const sel of ["div", ".x, .y, .z", "div span", ".x > .z", "[data-k]", "em:nth-child(1)"]) {
    assert.deepEqual(uids(doc.query(sel)), uids(doc.queryScan(sel)), sel);
  }
});

test("validateIndex detects a stale parent relation", () => {
  const { doc, a, c } = sample();
  doc.index.parent.set(c, doc.root); // corrupt on purpose
  assert.throws(() => validateIndex(doc.root, doc.index), /stale parent/);
  doc.index.parent.set(c, a); // repair
  validateIndex(doc.root, doc.index);
});
