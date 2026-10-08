import test from "node:test";
import assert from "node:assert/strict";
import {
  Document,
  Op,
  OpId,
  PagedDocument,
  mergeOps,
  rangeSelection,
  resolveSelection,
  selectedText,
} from "../src/index.js";

test("replaying merged branches keeps selections consistent with the unpaginated model", () => {
  const base = new Document("a");
  const baseOps: Op[] = [];
  let parent: OpId | null = null;
  for (const char of "the quick fox") {
    const op = base.insert(parent, char);
    baseOps.push(op);
    parent = op.id;
  }
  const ids = baseOps.map((op) => op.id);

  const selection = rangeSelection(base, 4, 9);
  assert.equal(selectedText(base, selection), "quick");

  const branchA = Document.replay("a", baseOps);
  const opsA: Op[] = [];
  opsA.push(branchA.delete(ids[4]));
  opsA.push(branchA.delete(ids[5]));
  opsA.push(branchA.delete(ids[6]));
  let tailA = ids[12];
  for (const char of " red") {
    const op = branchA.insert(tailA, char);
    opsA.push(op);
    tailA = op.id;
  }

  const branchB = Document.replay("b", baseOps);
  const opsB: Op[] = [];
  let tailB = ids[12];
  for (const char of " lazy") {
    const op = branchB.insert(tailB, char);
    opsB.push(op);
    tailB = op.id;
  }
  opsB.push(branchB.delete(ids[10]));

  const mergedOps = mergeOps(baseOps, opsA, opsB);
  const doc = Document.replay("merged", mergedOps);
  assert.equal(doc.text(), "the ck ox lazy red");

  const live = Document.replay("live", baseOps);
  for (const op of [...opsA, ...opsB]) live.apply(op);
  assert.equal(doc.text(), live.text());

  const expected = resolveSelection(doc, selection);
  assert.deepEqual(expected, { start: 4, end: 6 });
  assert.equal(selectedText(doc, selection), "ck");
  assert.deepEqual(selection.anchor, { type: "char", id: ids[4] });
  assert.deepEqual(selection.head, { type: "char", id: ids[9] });

  const paged = new PagedDocument(doc, 5);
  assert.deepEqual(
    paged.pages().map((page) => page.text),
    ["the c", "k ox ", "lazy ", "red"],
  );
  const pagedResolved = paged.resolveSelection(selection);
  assert.equal(pagedResolved.start, expected.start);
  assert.equal(pagedResolved.end, expected.end);
  assert.deepEqual(
    { page: pagedResolved.startPos.page, offsetInPage: pagedResolved.startPos.offsetInPage },
    { page: 0, offsetInPage: 4 },
  );
  assert.deepEqual(
    { page: pagedResolved.endPos.page, offsetInPage: pagedResolved.endPos.offsetInPage },
    { page: 1, offsetInPage: 1 },
  );

  paged.moveAcrossPageBoundary(0, 2);
  paged.reflow(4);
  const afterReflow = paged.resolveSelection(selection);
  assert.equal(afterReflow.start, expected.start);
  assert.equal(afterReflow.end, expected.end);
  assert.deepEqual(selection.anchor, { type: "char", id: ids[4] });
  assert.deepEqual(selection.head, { type: "char", id: ids[9] });
});
