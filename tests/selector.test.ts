import { test } from "node:test";
import assert from "node:assert/strict";
import { parseNth, nthMatches, parseSelectorList } from "../src/selector.js";

test("parseNth handles keywords, integers and an+b forms", () => {
  assert.deepEqual(parseNth("odd"), { a: 2, b: 1 });
  assert.deepEqual(parseNth("even"), { a: 2, b: 0 });
  assert.deepEqual(parseNth("3"), { a: 0, b: 3 });
  assert.deepEqual(parseNth("n"), { a: 1, b: 0 });
  assert.deepEqual(parseNth("-n"), { a: -1, b: 0 });
  assert.deepEqual(parseNth("2n+1"), { a: 2, b: 1 });
  assert.deepEqual(parseNth(" 2n + 1 "), { a: 2, b: 1 });
  assert.deepEqual(parseNth("-n+3"), { a: -1, b: 3 });
  assert.deepEqual(parseNth("3n-2"), { a: 3, b: -2 });
  assert.throws(() => parseNth("2x+1"), /invalid nth-child/);
});

test("nthMatches evaluates positions", () => {
  assert.equal(nthMatches(1, { a: 2, b: 1 }), true);
  assert.equal(nthMatches(2, { a: 2, b: 1 }), false);
  assert.equal(nthMatches(5, { a: 2, b: 1 }), true);
  assert.equal(nthMatches(3, { a: 0, b: 3 }), true);
  assert.equal(nthMatches(2, { a: 0, b: 3 }), false);
  assert.equal(nthMatches(3, { a: -1, b: 3 }), true);
  assert.equal(nthMatches(4, { a: -1, b: 3 }), false);
  assert.equal(nthMatches(1, { a: 3, b: -2 }), true);
  assert.equal(nthMatches(4, { a: 3, b: -2 }), true);
  assert.equal(nthMatches(3, { a: 3, b: -2 }), false);
});

test("parses compound selectors", () => {
  const [sel] = parseSelectorList('div.x.y[data-a="1"][hidden]:nth-child(2n+1)');
  assert.equal(sel!.parts.length, 1);
  const c = sel!.parts[0]!;
  assert.equal(c.tag, "div");
  assert.deepEqual(c.classes, ["x", "y"]);
  assert.deepEqual(c.attrs, [{ name: "data-a", value: "1" }, { name: "hidden" }]);
  assert.deepEqual(c.nth, { a: 2, b: 1 });
});

test("parses combinators and selector lists", () => {
  const [a, b] = parseSelectorList("div > .x, ul li");
  assert.deepEqual(a!.combs, [">"]);
  assert.equal(a!.parts[0]!.tag, "div");
  assert.equal(a!.parts[1]!.classes[0], "x");
  assert.deepEqual(b!.combs, [" "]);
  assert.equal(b!.parts[0]!.tag, "ul");
  assert.equal(b!.parts[1]!.tag, "li");
});

test("comma inside attribute value does not split the list", () => {
  const list = parseSelectorList('[data-x="a,b"], span');
  assert.equal(list.length, 2);
  assert.equal(list[0]!.parts[0]!.attrs[0]!.value, "a,b");
});

test("rejects malformed selectors", () => {
  assert.throws(() => parseSelectorList("div,"), /empty selector/);
  assert.throws(() => parseSelectorList("div .. x"), /invalid class|empty compound/);
  assert.throws(() => parseSelectorList("div:nth-of-type(2)"), /only :nth-child/);
  assert.throws(() => parseSelectorList("[data-x"), /unterminated/);
});
