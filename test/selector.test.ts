import { test } from "node:test";
import { deepEqual, equal, throws } from "node:assert/strict";
import { nthMatches, parseNth, parseSelectorList } from "../src/selector.js";

test("parse simple compound selectors", () => {
  deepEqual(parseSelectorList("div"), [
    { compounds: [{ tag: "div", classes: [], attrs: [], nth: null }], combinators: [] },
  ]);
  deepEqual(parseSelectorList("*"), [
    { compounds: [{ tag: null, classes: [], attrs: [], nth: null }], combinators: [] },
  ]);
  deepEqual(parseSelectorList("div.a.b"), [
    { compounds: [{ tag: "div", classes: ["a", "b"], attrs: [], nth: null }], combinators: [] },
  ]);
});

test("parse attribute selectors", () => {
  deepEqual(parseSelectorList("[data-k]"), [
    {
      compounds: [{ tag: null, classes: [], attrs: [{ name: "data-k", value: null }], nth: null }],
      combinators: [],
    },
  ]);
  deepEqual(parseSelectorList('[data-k="v1"]'), [
    {
      compounds: [{ tag: null, classes: [], attrs: [{ name: "data-k", value: "v1" }], nth: null }],
      combinators: [],
    },
  ]);
  deepEqual(parseSelectorList("[data-k=v2]"), [
    {
      compounds: [{ tag: null, classes: [], attrs: [{ name: "data-k", value: "v2" }], nth: null }],
      combinators: [],
    },
  ]);
});

test("parse combinators", () => {
  const [cx] = parseSelectorList("section > div .x");
  equal(cx!.compounds.length, 3);
  deepEqual(cx!.combinators, ["child", "descendant"]);
  const [cx2] = parseSelectorList("ul>li");
  deepEqual(cx2!.combinators, ["child"]);
});

test("parse selector lists", () => {
  const list = parseSelectorList("div, .x , ul > li");
  equal(list.length, 3);
  equal(list[2]!.combinators[0], "child");
});

test("parse :nth-child variants", () => {
  deepEqual(parseNth("odd"), { a: 2, b: 1 });
  deepEqual(parseNth("even"), { a: 2, b: 0 });
  deepEqual(parseNth("3"), { a: 0, b: 3 });
  deepEqual(parseNth("n"), { a: 1, b: 0 });
  deepEqual(parseNth("2n+1"), { a: 2, b: 1 });
  deepEqual(parseNth("-n+3"), { a: -1, b: 3 });
  deepEqual(parseNth(" 2n - 1 "), { a: 2, b: -1 });
  throws(() => parseNth("nonsense"), /invalid :nth-child/);
});

test("nthMatches semantics", () => {
  equal(nthMatches(1, { a: 2, b: 1 }), true);
  equal(nthMatches(2, { a: 2, b: 1 }), false);
  equal(nthMatches(3, { a: 0, b: 3 }), true);
  equal(nthMatches(4, { a: 0, b: 3 }), false);
  equal(nthMatches(3, { a: -1, b: 3 }), true);
  equal(nthMatches(4, { a: -1, b: 3 }), false);
  equal(nthMatches(1, { a: 1, b: 0 }), true);
});

test("selector list commas inside brackets are not split", () => {
  const list = parseSelectorList('[data-x="a,b"], div');
  equal(list.length, 2);
  equal(list[0]!.compounds[0]!.attrs[0]!.value, "a,b");
});

test("invalid selectors throw", () => {
  throws(() => parseSelectorList(""));
  throws(() => parseSelectorList("div >"));
  throws(() => parseSelectorList("div..a"));
  throws(() => parseSelectorList("div:unknown(1)"));
});
