import { test } from "node:test";
import { deepEqual, equal, throws } from "node:assert/strict";
import { ConfigEditor, parse } from "../src/config";

test("parse: values, spans, leading and trailing comments", () => {
  const text = "# top\n\n# about a\n# more a\na   =   hello world   # tail\nb=two\n";
  const doc = parse(text);

  deepEqual(
    doc.entries.map((e) => [e.key, e.value]),
    [
      ["a", "hello world"],
      ["b", "two"],
    ]
  );

  const a = doc.entries[0];
  deepEqual(
    a.leadingComments.map((c) => c.text),
    ["# about a", "# more a"]
  );
  equal(a.trailingComment?.text, "# tail");
  equal(text.slice(a.valueSpan.start, a.valueSpan.end), "hello world");
  equal(text.slice(a.keySpan.start, a.keySpan.end), "a");

  // The trailing comment of `a` is a same-line comment, not a comment
  // line, so `b` has no leading comments.
  deepEqual(doc.entries[1].leadingComments, []);

  // "# top" is separated by a blank line: unattached.
  deepEqual(
    doc.comments.map((c) => c.text),
    ["# top", "# about a", "# more a"]
  );
});

test("parse: value may contain '=' and '#' without preceding whitespace", () => {
  const doc = parse("a = x=y#z\n");
  equal(doc.entries[0].value, "x=y#z");
  equal(doc.entries[0].trailingComment, null);
});

test("parse: empty values", () => {
  const doc = parse("a =\nb=\nc = # only comment\n");
  deepEqual(
    doc.entries.map((e) => e.value),
    ["", "", ""]
  );
  equal(doc.entries[2].trailingComment?.text, "# only comment");
});

test("parse: duplicate keys are reported", () => {
  const doc = parse("a = 1\nb = 2\na = 3\n");
  deepEqual(doc.duplicateKeys, ["a"]);
});

test("parse: malformed line throws", () => {
  throws(() => parse("just some words\n"), /invalid config line/);
  throws(() => parse("= 1\n"), /invalid config line/);
});

test("set: replaces only the value span, all other bytes preserved", () => {
  const text = "# c\na = 1 # tail\nb = 2\n";
  const span = parse(text).entries[0].valueSpan;
  const ed = new ConfigEditor(text);
  ed.set("a", "hello");
  const out = ed.toString();

  equal(out, "# c\na = hello # tail\nb = 2\n");
  // Byte-for-byte preservation outside the value span.
  equal(out.slice(0, span.start), text.slice(0, span.start));
  equal(out.slice(span.start + "hello".length), text.slice(span.end));
  equal(ed.get("a"), "hello");
  equal(ed.get("b"), "2");
});

test("set: empty value positions", () => {
  const ed = new ConfigEditor("a = \n");
  ed.set("a", "x");
  equal(ed.toString(), "a = x\n");
  ed.set("a", "");
  equal(ed.toString(), "a = \n");
});

test("set: rejects values that would not round-trip", () => {
  const ed = new ConfigEditor("a = 1\n");
  throws(() => ed.set("a", "x\ny"), /line breaks/);
  throws(() => ed.set("a", " x"), /whitespace/);
  throws(() => ed.set("a", "x "), /whitespace/);
  throws(() => ed.set("a", "x # y"), /comment marker/);
  throws(() => ed.set("a", "#x"), /comment marker/);
  equal(ed.toString(), "a = 1\n");
});

test("set: unknown key throws", () => {
  const ed = new ConfigEditor("a = 1\n");
  throws(() => ed.set("nope", "2"), /unknown key/);
});

test("duplicate keys: every keyed edit is rejected, text untouched", () => {
  const text = "a = 1\na = 2\nb = 3\n";
  const ed = new ConfigEditor(text);
  throws(() => ed.set("a", "9"), /duplicate key/);
  throws(() => ed.get("a"), /duplicate key/);
  throws(() => ed.moveBefore("a", "b"), /duplicate key/);
  throws(() => ed.moveAfter("b", "a"), /duplicate key/);
  equal(ed.toString(), text);
  equal(ed.get("b"), "3");
});

test("moveBefore: leading comments travel with the key, tail comments stay", () => {
  const text = [
    "# header",
    "",
    "# about a",
    "# more a",
    "a = 1",
    "# about b",
    "b = 2  # tail b",
    "c = 3",
    "# trailing note",
    "",
  ].join("\n");
  const ed = new ConfigEditor(text);
  ed.moveBefore("b", "a");
  const expected = [
    "# header",
    "",
    "# about b",
    "b = 2  # tail b",
    "# about a",
    "# more a",
    "a = 1",
    "c = 3",
    "# trailing note",
    "",
  ].join("\n");
  equal(ed.toString(), expected);

  const doc = ed.document;
  deepEqual(doc.entries.map((e) => e.key), ["b", "a", "c"]);
  deepEqual(
    doc.entries[0].leadingComments.map((c) => c.text),
    ["# about b"]
  );
  equal(doc.entries[0].trailingComment?.text, "# tail b");
  deepEqual(doc.entries[2].leadingComments, []);
  deepEqual(
    doc.entries.map((e) => e.value),
    ["2", "1", "3"]
  );
});

test("moveAfter: moves block past the target including its comments", () => {
  const text = "# about a\na = 1\nb = 2\n# about c\nc = 3\n";
  const ed = new ConfigEditor(text);
  ed.moveAfter("a", "c");
  equal(ed.toString(), "b = 2\n# about c\nc = 3\n# about a\na = 1\n");
  deepEqual(ed.keys(), ["b", "c", "a"]);
});

test("move: no-op when already in position or same key", () => {
  const text = "a = 1\nb = 2\n";
  const ed = new ConfigEditor(text);
  ed.moveBefore("a", "b");
  ed.moveBefore("a", "a");
  ed.moveAfter("b", "a");
  equal(ed.toString(), text);
});

test("move: last line without trailing newline", () => {
  const ed = new ConfigEditor("a = 1\nb = 2");
  ed.moveBefore("b", "a");
  equal(ed.toString(), "b = 2\na = 1\n");

  const ed2 = new ConfigEditor("a = 1\nb = 2");
  ed2.moveAfter("a", "b");
  equal(ed2.toString(), "b = 2\na = 1\n");
});

test("CRLF line endings are preserved byte-for-byte", () => {
  const text = "# c\r\na = 1\r\nb = 2\r\n";
  const ed = new ConfigEditor(text);
  ed.set("b", "3");
  equal(ed.toString(), "# c\r\na = 1\r\nb = 3\r\n");
  // "# c" is the leading comment of "a", so "b" lands in front of it.
  ed.moveBefore("b", "a");
  equal(ed.toString(), "b = 3\r\n# c\r\na = 1\r\n");
});

test("unicode keys, values and comments round-trip", () => {
  const ed = new ConfigEditor("# 注释\n名字 = 值\n");
  ed.set("名字", "新值");
  equal(ed.toString(), "# 注释\n名字 = 新值\n");
  equal(ed.get("名字"), "新值");
});

test("every operation is verified by re-parsing values and comments", () => {
  const ed = new ConfigEditor("# x\na = 1 # t\n# y\nb = 2\n");
  ed.set("a", "10");
  ed.moveAfter("b", "a");
  ed.set("b", "20");
  ed.validate();
  const doc = ConfigEditor.parse(ed.toString());
  deepEqual(
    doc.entries.map((e) => [e.key, e.value]),
    [
      ["a", "10"],
      ["b", "20"],
    ]
  );
  deepEqual(
    doc.entries[1].leadingComments.map((c) => c.text),
    ["# y"]
  );
  equal(doc.entries[0].trailingComment?.text, "# t");
});

test("get/has/keys basics", () => {
  const ed = new ConfigEditor("a = 1\nb = 2\n");
  equal(ed.get("a"), "1");
  equal(ed.get("missing"), undefined);
  equal(ed.has("b"), true);
  equal(ed.has("missing"), false);
  deepEqual(ed.keys(), ["a", "b"]);
});
