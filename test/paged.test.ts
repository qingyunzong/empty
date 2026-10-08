import test from "node:test";
import assert from "node:assert/strict";
import { PagedDocument, rangeSelection } from "../src/index.js";
import { docWithText } from "./helpers.js";

test("pagination chunks the visible text without changing ids", () => {
  const { doc, ids } = docWithText("a", "abcdefghij");
  const paged = new PagedDocument(doc, 4);
  assert.deepEqual(
    paged.pages().map((page) => page.text),
    ["abcd", "efgh", "ij"],
  );
  assert.deepEqual(paged.locate(ids[5]), { offset: 5, page: 1, offsetInPage: 1 });
  assert.deepEqual(paged.pages()[1].ids[1], ids[5]);
});

test("moving chars across a page boundary keeps ids and global offsets", () => {
  const { doc, ids } = docWithText("a", "abcdefghij");
  const paged = new PagedDocument(doc, 4);
  const before = paged.locate(ids[5]);
  paged.moveAcrossPageBoundary(0, 2);
  assert.deepEqual(
    paged.pages().map((page) => page.text),
    ["ab", "cdefgh", "ij"],
  );
  const after = paged.locate(ids[5]);
  assert.deepEqual(after, { offset: 5, page: 1, offsetInPage: 3 });
  assert.equal(after?.offset, before?.offset);
  paged.reflow(3);
  assert.deepEqual(
    paged.pages().map((page) => page.text),
    ["abc", "def", "ghi", "j"],
  );
  assert.deepEqual(paged.locate(ids[5]), { offset: 5, page: 1, offsetInPage: 2 });
});

test("paged selection resolution matches the unpaginated model", () => {
  const { doc } = docWithText("a", "abcdefghij");
  const selection = rangeSelection(doc, 2, 7);
  const paged = new PagedDocument(doc, 4);

  const first = paged.resolveSelection(selection);
  assert.equal(first.start, 2);
  assert.equal(first.end, 7);
  assert.deepEqual(
    { page: first.startPos.page, offsetInPage: first.startPos.offsetInPage },
    { page: 0, offsetInPage: 2 },
  );
  assert.deepEqual(
    { page: first.endPos.page, offsetInPage: first.endPos.offsetInPage },
    { page: 1, offsetInPage: 3 },
  );

  paged.reflow(3);
  const second = paged.resolveSelection(selection);
  assert.equal(second.start, 2);
  assert.equal(second.end, 7);
  assert.deepEqual(
    { page: second.endPos.page, offsetInPage: second.endPos.offsetInPage },
    { page: 2, offsetInPage: 1 },
  );
});
