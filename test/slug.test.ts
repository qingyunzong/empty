import { test } from "node:test";
import assert from "node:assert/strict";
import { slugify, Slugger } from "../src/slug.ts";

test("slugify lowercases ASCII only", () => {
  assert.equal(slugify("Hello World"), "hello-world");
  assert.equal(slugify("ABC def GHI"), "abc-def-ghi");
  // Non-ASCII is preserved as-is.
  assert.equal(slugify("标题 Heading"), "标题-heading");
});

test("slugify folds whitespace runs into a single hyphen", () => {
  assert.equal(slugify("a   b\t\tc"), "a-b-c");
  assert.equal(slugify("   padded   "), "padded");
  assert.equal(slugify(""), "");
});

test("Slugger appends sequence numbers to duplicates", () => {
  const s = new Slugger();
  assert.equal(s.slug("Intro"), "intro");
  assert.equal(s.slug("intro"), "intro-1");
  assert.equal(s.slug("INTRO"), "intro-2");
  assert.equal(s.slug("Other"), "other");
  assert.equal(s.slug("Intro"), "intro-3");
});
