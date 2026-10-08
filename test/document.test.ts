import test from "node:test";
import assert from "node:assert/strict";
import { Document, mergeOps } from "../src/index.js";
import { docWithText } from "./helpers.js";

test("sequential inserts and deletes build the expected text", () => {
  const { doc, ids } = docWithText("a", "hello");
  assert.equal(doc.text(), "hello");
  doc.delete(ids[1]);
  assert.equal(doc.text(), "hllo");
  doc.delete(ids[1]);
  assert.equal(doc.text(), "hllo");
});

test("concurrent inserts at the same position are ordered by operation id", () => {
  const base = new Document("a");
  const root = base.insert(null, "A");

  const branchA = Document.replay("a", [root]);
  const insertX = branchA.insert(root.id, "x"); // 2@a

  const branchB = Document.replay("b", [root]);
  const insertY = branchB.insert(root.id, "y"); // 2@b

  const merged = Document.replay("r", [root, insertX, insertY]);
  assert.equal(merged.text(), "Axy");

  const reversed = new Document("r");
  reversed.apply(root);
  reversed.apply(insertY);
  reversed.apply(insertX);
  assert.equal(reversed.text(), "Axy");
});

test("merge + replay converges with incremental application", () => {
  const base = new Document("a");
  const baseOps = [];
  let parent = null;
  for (const char of "abc") {
    const op = base.insert(parent, char);
    baseOps.push(op);
    parent = op.id;
  }

  const branchA = Document.replay("a", baseOps);
  const opsA = [branchA.insert(baseOps[2].id, "x")];

  const branchB = Document.replay("b", baseOps);
  const opsB = [branchB.delete(baseOps[0].id), branchB.insert(baseOps[1].id, "y")];

  const live = Document.replay("live", baseOps);
  for (const op of [...opsA, ...opsB]) live.apply(op);

  const merged = Document.replay("merged", mergeOps(baseOps, opsA, opsB));
  assert.equal(merged.text(), live.text());
  assert.equal(merged.text(), "bcxy");
});
