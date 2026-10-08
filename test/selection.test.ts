import test from "node:test";
import assert from "node:assert/strict";
import {
  caretAnchor,
  rangeSelection,
  resolveAnchor,
  resolveSelection,
  selectedText,
} from "../src/index.js";
import { docWithText } from "./helpers.js";

test("selections store stable char ids and resolve to offsets", () => {
  const { doc, ids } = docWithText("a", "abcd");
  const selection = rangeSelection(doc, 1, 3);
  assert.deepEqual(resolveSelection(doc, selection), { start: 1, end: 3 });
  assert.equal(selectedText(doc, selection), "bc");
  assert.deepEqual(selection.anchor, { type: "char", id: ids[1] });
  assert.deepEqual(selection.head, { type: "char", id: ids[3] });
});

test("caret at document end uses the end anchor", () => {
  const { doc } = docWithText("a", "ab");
  const anchor = caretAnchor(doc, 2);
  assert.deepEqual(anchor, { type: "end" });
  assert.equal(resolveAnchor(doc, anchor), 2);
});

test("deleted anchor shifts to the nearest surviving char on the right", () => {
  const { doc, ids } = docWithText("a", "abcd");
  const selection = rangeSelection(doc, 1, 2);
  doc.delete(ids[1]);
  assert.equal(doc.text(), "acd");
  assert.deepEqual(resolveSelection(doc, selection), { start: 1, end: 1 });
  assert.deepEqual(selection.anchor, { type: "char", id: ids[1] });
});

test("anchor skips a run of deleted chars", () => {
  const { doc, ids } = docWithText("a", "abcde");
  const selection = rangeSelection(doc, 1, 2);
  doc.delete(ids[1]);
  doc.delete(ids[2]);
  doc.delete(ids[3]);
  assert.equal(doc.text(), "ae");
  assert.deepEqual(resolveSelection(doc, selection), { start: 1, end: 1 });
});

test("anchor falls back to document end when nothing survives on the right", () => {
  const { doc, ids } = docWithText("a", "abcd");
  const selection = rangeSelection(doc, 2, 4);
  doc.delete(ids[2]);
  doc.delete(ids[3]);
  assert.equal(doc.text(), "ab");
  assert.deepEqual(resolveSelection(doc, selection), { start: 2, end: 2 });
});

test("anchors survive unrelated edits without changing id", () => {
  const { doc, ids } = docWithText("a", "abcd");
  const selection = rangeSelection(doc, 1, 3);
  doc.insert(ids[3], "X");
  doc.delete(ids[0]);
  assert.equal(doc.text(), "bcdX");
  assert.deepEqual(resolveSelection(doc, selection), { start: 0, end: 2 });
  assert.equal(selectedText(doc, selection), "bc");
  assert.deepEqual(selection.anchor, { type: "char", id: ids[1] });
  assert.deepEqual(selection.head, { type: "char", id: ids[3] });
});
