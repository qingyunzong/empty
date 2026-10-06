import { test } from "node:test";
import * as assert from "node:assert/strict";
import { parseSelector, SelectorSyntaxError } from "../src/index.js";

test("parses a bare tag selector", () => {
  const ast = parseSelector("div");
  assert.equal(ast.complexes.length, 1);
  const c = ast.complexes[0]!;
  assert.equal(c.compounds.length, 1);
  assert.equal(c.compounds[0]!.tag, "div");
  assert.equal(c.compounds[0]!.attrs.length, 0);
  assert.equal(c.combinators.length, 0);
});

test("parses universal and attribute selectors", () => {
  const ast = parseSelector("*");
  assert.equal(ast.complexes[0]!.compounds[0]!.tag, null);

  const presence = parseSelector("[hidden]");
  assert.deepEqual(presence.complexes[0]!.compounds[0]!.attrs, [
    { name: "hidden", value: null },
  ]);

  const eq = parseSelector("[data-x=1]");
  assert.deepEqual(eq.complexes[0]!.compounds[0]!.attrs, [
    { name: "data-x", value: "1" },
  ]);

  const quoted = parseSelector('[data-y="a b"]');
  assert.deepEqual(quoted.complexes[0]!.compounds[0]!.attrs, [
    { name: "data-y", value: "a b" },
  ]);

  const single = parseSelector("[data-y='z']");
  assert.deepEqual(single.complexes[0]!.compounds[0]!.attrs, [
    { name: "data-y", value: "z" },
  ]);
});

test("parses compound selectors with tag and multiple attributes", () => {
  const ast = parseSelector('div[data-x=1][data-y="2"]');
  const c = ast.complexes[0]!.compounds[0]!;
  assert.equal(c.tag, "div");
  assert.deepEqual(c.attrs, [
    { name: "data-x", value: "1" },
    { name: "data-y", value: "2" },
  ]);
});

test("parses child and descendant combinators", () => {
  const ast = parseSelector("div > ul li");
  const c = ast.complexes[0]!;
  assert.deepEqual(
    c.compounds.map((x) => x.tag),
    ["div", "ul", "li"],
  );
  assert.deepEqual(c.combinators, ["child", "descendant"]);

  const tight = parseSelector("div>span");
  assert.deepEqual(tight.complexes[0]!.combinators, ["child"]);

  const multiWs = parseSelector("div \t\n span");
  assert.deepEqual(multiWs.complexes[0]!.combinators, ["descendant"]);
});

test("parses comma unions", () => {
  const ast = parseSelector("a, b > c, [x=1]");
  assert.equal(ast.complexes.length, 3);
  assert.equal(ast.complexes[0]!.compounds[0]!.tag, "a");
  assert.deepEqual(ast.complexes[1]!.combinators, ["child"]);
  assert.deepEqual(ast.complexes[2]!.compounds[0]!.attrs, [
    { name: "x", value: "1" },
  ]);
});

function assertErrorRange(
  source: string,
  start: number,
  end: number,
  pattern: RegExp,
): void {
  try {
    parseSelector(source);
  } catch (err) {
    assert.ok(err instanceof SelectorSyntaxError, "expected SelectorSyntaxError");
    assert.equal(err.start, start, `start for ${JSON.stringify(source)}`);
    assert.equal(err.end, end, `end for ${JSON.stringify(source)}`);
    assert.ok(pattern.test(err.message), `message for ${JSON.stringify(source)}: ${err.message}`);
    return;
  }
  assert.fail(`expected ${JSON.stringify(source)} to throw`);
}

test("reports character ranges for syntax errors", () => {
  assertErrorRange("", 0, 0, /expected a selector/);
  assertErrorRange("   ", 3, 3, /expected a selector/);
  assertErrorRange("div >", 4, 5, /after '>'/);
  assertErrorRange("div > ", 4, 6, /after '>'/);
  assertErrorRange("div,", 3, 4, /after ','/);
  assertErrorRange("div,,span", 4, 5, /expected a tag name/);
  assertErrorRange("[a=]", 3, 4, /attribute value/);
  assertErrorRange("[a='x", 3, 5, /unterminated string/);
  assertErrorRange("[a", 2, 3, /expected '=' or '\]'/);
  assertErrorRange("[a=1", 4, 5, /expected '\]'/);
  assertErrorRange("div]", 3, 4, /unexpected character/);
  assertErrorRange("div > > span", 6, 7, /expected a tag name/);
  assertErrorRange("> div", 0, 1, /expected a tag name/);
  assertErrorRange("div span!", 8, 9, /unexpected character/);
});
