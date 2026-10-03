"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { parseCSV, parseTable } = require("../src/csv");

test("parses quoted fields, escaped quotes and CRLF", () => {
  const rows = parseCSV('a,b\r\n"x,\ny","say ""hi"""\r\n1,2\n');
  assert.deepEqual(rows, [["a", "b"], ["x,\ny", 'say "hi"'], ["1", "2"]]);
});

test("empty fields and trailing newline", () => {
  assert.deepEqual(parseCSV("a,,b\n"), [["a", "", "b"]]);
  assert.deepEqual(parseCSV(""), []);
  assert.deepEqual(parseCSV("a,b\n1,2\n"), [["a", "b"], ["1", "2"]]);
});

test("parseTable splits header from rows", () => {
  const t = parseTable("id,v\n1,x\n2,y\n");
  assert.deepEqual(t.header, ["id", "v"]);
  assert.deepEqual(t.rows, [["1", "x"], ["2", "y"]]);
});
