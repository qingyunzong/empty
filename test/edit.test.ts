import { test } from "node:test";
import assert from "node:assert/strict";
import { parse, setByPath, deleteByPath, toPlain, formatScalar } from "../src/index.js";

test("set replaces only the scalar lexical span, preserving all other bytes", () => {
  const src = "# head\na: 1  # keep me\n\nb: old\n";
  const doc = parse(src);
  const r = setByPath(doc, ["a"], 22);
  assert.equal(r.changed, true);
  assert.equal(r.text, "# head\na: 22  # keep me\n\nb: old\n");
  // untouched prefix/suffix around the replaced span
  const e = r.edits[0]!;
  assert.equal(src.slice(0, e.start), r.text.slice(0, e.start));
  assert.equal(src.slice(e.end), r.text.slice(r.text.length - (src.length - e.end)));
});

test("set on implicit null (`key:`) inserts after the colon", () => {
  const r = setByPath(parse("a:\nb: 1\n"), ["a"], 5);
  assert.equal(r.text, "a: 5\nb: 1\n");
});

test("set on empty seq dash inserts after the dash", () => {
  const r = setByPath(parse("-\n- x\n"), [0], "v");
  assert.equal(r.text, "- v\n- x\n");
});

test("set quotes strings that would not round-trip as plain scalars", () => {
  assert.equal(formatScalar("plain"), "plain");
  assert.equal(formatScalar("null"), '"null"');
  assert.equal(formatScalar("a: b"), '"a: b"');
  assert.equal(formatScalar("with # hash"), '"with # hash"');
  const r = setByPath(parse("k: v\n"), ["k"], "true");
  assert.equal(r.text, 'k: "true"\n');
  assert.deepEqual(toPlain(parse(r.text).root), { k: "true" });
});

test("set on a missing path is a no-op", () => {
  const src = "a:\n  b: 1\n";
  const doc = parse(src);
  for (const p of [["x"], ["a", "x"], ["a", "b", "c"], ["a", "b", "0"]]) {
    const r = setByPath(doc, p, 9);
    assert.equal(r.changed, false);
    assert.equal(r.text, src);
    assert.equal(r.edits.length, 0);
  }
});

test("set on a container path throws", () => {
  assert.throws(() => setByPath(parse("a:\n  b: 1\n"), ["a"], 9), TypeError);
});

test("delete moves trailing comments to the previous surviving item", () => {
  const src = "a: 1\n# about b\n# more about b\nb: 2\nc: 3\n";
  const r = deleteByPath(parse(src), ["b"]);
  assert.equal(r.text, "a: 1\n# about b\n# more about b\nc: 3\n");
  assert.deepEqual(toPlain(parse(r.text).root), { a: 1, c: 3 });
});

test("delete of first item leaves its trailing comments in place", () => {
  const src = "# owned by a\na: 1\nb: 2\n";
  const r = deleteByPath(parse(src), ["a"]);
  assert.equal(r.text, "# owned by a\nb: 2\n");
});

test("delete in a sequence moves comments to the previous item", () => {
  const src = "- alpha\n# note on beta\n- beta\n- gamma\n";
  const r = deleteByPath(parse(src), [1]);
  assert.equal(r.text, "- alpha\n# note on beta\n- gamma\n");
  assert.deepEqual(toPlain(parse(r.text).root), ["alpha", "gamma"]);
});

test("delete removes a whole nested block and relocates its trailing comments", () => {
  const src = "top:\n  x: 1\n  y: 2\n# tail of top\nother: yes\n";
  const r = deleteByPath(parse(src), ["top"]);
  assert.equal(r.text, "# tail of top\nother: yes\n");
  const src2 = "keep: 0\ntop:\n  x: 1\n# tail of top\nother: yes\n";
  const r2 = deleteByPath(parse(src2), ["top"]);
  assert.equal(r2.text, "keep: 0\n# tail of top\nother: yes\n");
});

test("comments separated by a blank line are not owned and stay put", () => {
  const src = "a: 1\n\n# detached\nb: 2\n";
  const r = deleteByPath(parse(src), ["a"]);
  assert.equal(r.text, "\n# detached\nb: 2\n");
});

test("delete of the last child turns the parent into an implicit null", () => {
  const r = deleteByPath(parse("a:\n  b: 1\nc: 2\n"), ["a", "b"]);
  assert.equal(r.text, "a:\nc: 2\n");
  assert.deepEqual(toPlain(parse(r.text).root), { a: null, c: 2 });
});

test("delete of a sole inline seq-map entry blanks the item to null", () => {
  const r = deleteByPath(parse("- a: 1 # note\n- b: 2\n"), [0, "a"]);
  assert.equal(r.text, "-  # note\n- b: 2\n");
  assert.deepEqual(toPlain(parse(r.text).root), [null, { b: 2 }]);
});

test("delete of the first inline entry of a multi-entry seq-map throws", () => {
  assert.throws(() => deleteByPath(parse("- a: 1\n  b: 2\n"), [0, "a"]), TypeError);
});

test("delete on a missing path is a no-op", () => {
  const src = "a: 1\nb:\n  - x\n";
  const doc = parse(src);
  for (const p of [["z"], ["b", "z"], ["b", 5], ["a", "b"]]) {
    const r = deleteByPath(doc, p);
    assert.equal(r.changed, false);
    assert.equal(r.text, src);
  }
});

test("re-parse after edits yields correct tree values", () => {
  let text = "server:\n  host: example.com # h\n  port: 8080\n  tls: false\nlist:\n  - 1\n  - 2\n";
  text = setByPath(parse(text), ["server", "port"], 9090).text;
  text = setByPath(parse(text), ["server", "tls"], true).text;
  text = deleteByPath(parse(text), ["list", 0]).text;
  assert.deepEqual(toPlain(parse(text).root), {
    server: { host: "example.com", port: 9090, tls: true },
    list: [2],
  });
});
