import { test } from "node:test";
import * as assert from "node:assert/strict";
import {
  Document,
  ElementNode,
  naiveQuery,
  preorder,
  isWithin,
} from "../src/index.js";
import type { Diff, Snapshot } from "../src/index.js";
import {
  mulberry32,
  buildRandomTree,
  randomSelector,
  assertSameNodes,
  ids,
  pick,
  TAGS,
  ATTRS,
  VALS,
} from "./helpers.js";

interface Event {
  diff: Diff;
  snapshot: Snapshot;
}

function recorder(events: Event[]) {
  return (diff: Diff, snapshot: Snapshot) => {
    events.push({ diff, snapshot });
  };
}

// root(html) > div#d > [span#s2, p#p > span#s1]
function basicDoc() {
  const doc = new Document();
  const d = doc.createElement("div", { id: "d" });
  doc.appendChild(doc.root, d);
  const s2 = doc.createElement("span", { id: "s2" });
  doc.appendChild(d, s2);
  const p = doc.createElement("p", { id: "p" });
  doc.appendChild(d, p);
  const s1 = doc.createElement("span", { id: "s1" });
  doc.appendChild(p, s1);
  doc.flush();
  return { doc, d, p, s1, s2 };
}

test("initial snapshot, append diff, and snapshot retention", () => {
  const { doc, d } = basicDoc();
  const events: Event[] = [];
  const q = doc.watch("span", recorder(events));

  assert.equal(q.snapshot.version, 0);
  assert.deepEqual(ids(q.snapshot.matches), ["s2", "s1"]);
  assert.equal(events.length, 0);

  const v0 = q.snapshot;

  const s3 = doc.createElement("span", { id: "s3" });
  doc.appendChild(d, s3);
  doc.flush();

  assert.equal(events.length, 1);
  assert.deepEqual(ids(events[0]!.diff.added), ["s3"]);
  assert.deepEqual(ids(events[0]!.diff.removed), []);
  assert.equal(events[0]!.diff.version, 1);
  assert.deepEqual(ids(q.snapshot.matches), ["s2", "s1", "s3"]);

  // the old snapshot object is untouched
  assert.equal(v0.version, 0);
  assert.deepEqual(ids(v0.matches), ["s2", "s1"]);
  assert.ok(Object.isFrozen(v0));
  assert.ok(Object.isFrozen(v0.matches));

  const v1 = q.snapshot;
  doc.removeChild(s3);
  doc.flush();
  assert.deepEqual(ids(events[1]!.diff.removed), ["s3"]);
  assert.deepEqual(ids(q.snapshot.matches), ["s2", "s1"]);
  // v1 still shows the three-span world
  assert.deepEqual(ids(v1.matches), ["s2", "s1", "s3"]);
});

test("attribute change on an ancestor invalidates descendant matches", () => {
  const { doc, d } = basicDoc();
  const events: Event[] = [];
  const q = doc.watch("div[data-x=1] span", recorder(events), { verify: true });
  assert.deepEqual(ids(q.snapshot.matches), []);

  doc.setAttribute(d, "data-x", "1");
  doc.flush();
  assert.equal(events.length, 1);
  assert.deepEqual(ids(events[0]!.diff.added), ["s2", "s1"]);
  assert.deepEqual(ids(q.snapshot.matches), ["s2", "s1"]);

  doc.setAttribute(d, "data-x", "2");
  doc.flush();
  assert.equal(events.length, 2);
  assert.deepEqual(ids(events[1]!.diff.removed), ["s2", "s1"]);
  assert.deepEqual(ids(q.snapshot.matches), []);
});

test("child combinator invalidation only reaches direct children", () => {
  const { doc, d } = basicDoc();
  const events: Event[] = [];
  doc.watch("div[data-x=1] > span", recorder(events), { verify: true });
  doc.setAttribute(d, "data-x", "1");
  doc.flush();
  assert.equal(events.length, 1);
  assert.deepEqual(ids(events[0]!.diff.added), ["s2"]); // s1 is a grandchild
});

test("removing a subtree removes its matched nodes", () => {
  const { doc, d } = basicDoc();
  const events: Event[] = [];
  doc.watch("span", recorder(events), { verify: true });
  doc.removeChild(d);
  doc.flush();
  assert.equal(events.length, 1);
  assert.deepEqual(ids(events[0]!.diff.removed), ["s2", "s1"]);
});

test("unions deduplicate live matches", () => {
  const { doc, d, s2 } = basicDoc();
  const events: Event[] = [];
  const q = doc.watch("span, [data-y=2]", recorder(events), { verify: true });
  assert.deepEqual(ids(q.snapshot.matches), ["s2", "s1"]);

  doc.setAttribute(s2, "data-y", "2"); // s2 now matches both branches
  doc.flush();
  assert.equal(events.length, 0); // membership unchanged
  assert.deepEqual(ids(q.snapshot.matches), ["s2", "s1"]);

  doc.removeAttribute(s2, "data-y");
  doc.flush();
  assert.equal(events.length, 0);

  const extra = doc.createElement("em", { id: "e1", "data-y": "2" });
  doc.appendChild(d, extra);
  doc.flush();
  assert.equal(events.length, 1);
  assert.deepEqual(ids(events[0]!.diff.added), ["e1"]);
});

test("mutations outside the scope do not notify; scope boundary is respected", () => {
  const doc = new Document();
  const inner = doc.createElement("div", { id: "inner" });
  const outer = doc.createElement("div", { id: "outer" });
  doc.appendChild(doc.root, inner);
  doc.appendChild(doc.root, outer);
  doc.flush();

  const events: Event[] = [];
  const q = doc.watch("div span", recorder(events), { scope: inner, verify: true });
  assert.deepEqual(ids(q.snapshot.matches), []);

  // a span under outer whose div ancestor exists only outside the scope
  const s = doc.createElement("span", { id: "os" });
  doc.appendChild(outer, s);
  doc.flush();
  assert.equal(events.length, 0);

  // a span inside the scope matches via the scope root itself
  const is = doc.createElement("span", { id: "is" });
  doc.appendChild(inner, is);
  doc.flush();
  assert.equal(events.length, 1);
  assert.deepEqual(ids(events[0]!.diff.added), ["is"]);
});

test("reentrant mutations from callbacks are processed in the next batch", () => {
  const { doc, d } = basicDoc();
  doc.removeChild(d.children[0]!); // remove s2
  doc.removeChild(d.children[0]!); // remove p (with s1)
  doc.flush();

  const batches: Diff[] = [];
  let reentered = false;
  const q = doc.watch("span", (diff) => {
    batches.push(diff);
    if (!reentered && diff.added.length > 0) {
      reentered = true;
      // mutate inside the callback: must land in a later batch
      doc.appendChild(d, doc.createElement("span", { id: "extra" }));
    }
  });

  const s = doc.createElement("span", { id: "s" });
  doc.appendChild(d, s);
  doc.flush();

  assert.equal(batches.length, 2);
  assert.deepEqual(ids(batches[0]!.added), ["s"]);
  assert.deepEqual(ids(batches[1]!.added), ["extra"]);
  assert.equal(batches[0]!.version, 1);
  assert.equal(batches[1]!.version, 2);
  assert.deepEqual(ids(q.snapshot.matches), ["s", "extra"]);
});

test("multiple mutations in one batch produce a single diff", () => {
  const { doc, d } = basicDoc();
  const events: Event[] = [];
  doc.watch("span", recorder(events), { verify: true });
  const a = doc.createElement("span", { id: "a" });
  const b = doc.createElement("span", { id: "b" });
  doc.appendChild(d, a);
  doc.appendChild(d, b);
  doc.removeChild(d.children[0]!); // remove s2
  doc.flush();
  assert.equal(events.length, 1);
  assert.deepEqual(ids(events[0]!.diff.added), ["a", "b"]);
  assert.deepEqual(ids(events[0]!.diff.removed), ["s2"]);
});

test("async mutations are applied without an explicit flush", async () => {
  const { doc, d } = basicDoc();
  const events: Event[] = [];
  const q = doc.watch("span", recorder(events));
  doc.appendChild(d, doc.createElement("span", { id: "async1" }));
  await doc.whenIdle();
  assert.equal(events.length, 1);
  assert.deepEqual(ids(q.snapshot.matches), ["s2", "s1", "async1"]);
});

test("moving a matched node keeps membership but updates document order", () => {
  const { doc, d, s1, s2 } = basicDoc();
  const events: Event[] = [];
  const q = doc.watch("span", recorder(events), { verify: true });
  assert.deepEqual(ids(q.snapshot.matches), ["s2", "s1"]);
  // move s2 after the <p> so order becomes [s1, s2]
  doc.appendChild(d, s2);
  doc.flush();
  assert.deepEqual(ids(q.snapshot.matches), ["s1", "s2"]);
  assertSameNodes([...q.snapshot.matches], naiveQuery(doc.root, "span"));
  void s1;
  void events;
});

test("fuzz: live diffs track the naive reference under random mutations", () => {
  const rand = mulberry32(0xBADC0DE);
  for (let iter = 0; iter < 40; iter++) {
    const doc = new Document();
    buildRandomTree(doc, rand, 20);
    doc.flush();

    const selectorCount = 1 + Math.floor(rand() * 3);
    const selectors: string[] = [];
    for (let i = 0; i < selectorCount; i++) selectors.push(randomSelector(rand));

    // half of the queries are scoped to a random inner node
    const all = [...preorder(doc.root)];
    const liveSets: Set<ElementNode>[] = [];
    for (const [i, selector] of selectors.entries()) {
      const scope = i % 2 === 1 ? pick(rand, all) : doc.root;
      const live = new Set<ElementNode>(naiveQuery(scope, selector));
      liveSets.push(live);
      doc.watch(
        selector,
        (diff) => {
          for (const n of diff.removed) {
            assert.ok(live.delete(n), `removed unknown node ${n.getAttribute("id")}`);
          }
          for (const n of diff.added) {
            assert.ok(!live.has(n), `added duplicate node ${n.getAttribute("id")}`);
            live.add(n);
          }
        },
        { scope, verify: true },
      );
    }

    const queries = [...(doc as unknown as { queries: Set<{ snapshot: Snapshot; scope: ElementNode; source: string }> }).queries];

    const opCount = 60;
    for (let op = 0; op < opCount; op++) {
      const nodes = [...preorder(doc.root)];
      const kind = rand();
      if (kind < 0.35) {
        // add
        const parent = pick(rand, nodes);
        const node = doc.createElement(pick(rand, TAGS), { id: `x${iter}_${op}` });
        if (rand() < 0.5) node.attributes.set(pick(rand, ATTRS), pick(rand, VALS));
        doc.appendChild(parent, node);
      } else if (kind < 0.55 && nodes.length > 1) {
        // remove (never the root)
        const node = pick(rand, nodes.filter((n) => n !== doc.root));
        doc.removeChild(node);
      } else if (kind < 0.8) {
        // attribute set/remove
        const node = pick(rand, nodes);
        const attr = pick(rand, ATTRS);
        if (rand() < 0.6) doc.setAttribute(node, attr, pick(rand, VALS));
        else doc.removeAttribute(node, attr);
      } else if (nodes.length > 1) {
        // move (guard against cycles)
        const node = pick(rand, nodes.filter((n) => n !== doc.root));
        const target = pick(rand, nodes);
        if (!isWithin(target, node)) doc.appendChild(target, node);
      }
      // flush at random intervals to vary batch sizes
      if (rand() < 0.5) doc.flush();
    }
    doc.flush();

    // verify:true already cross-checked every batch; do a final full compare
    // and check the reconstructed diff stream agrees.
    for (const [i, q] of queries.entries()) {
      const expected = naiveQuery(q.scope, q.source);
      assertSameNodes(
        [...q.snapshot.matches],
        expected,
        `iter ${iter} query ${i} ${JSON.stringify(q.source)}`,
      );
      const expectedSet = new Set(expected);
      assert.equal(liveSets[i]!.size, expectedSet.size, `iter ${iter} diff-stream size`);
      for (const n of expectedSet) {
        assert.ok(liveSets[i]!.has(n), `iter ${iter} diff-stream missing node`);
      }
    }
  }
});
