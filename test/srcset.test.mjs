import test from "node:test";
import assert from "node:assert/strict";

import { parseSrcset, Rational } from "../dist/index.js";

const base = "https://cdn.example.test/images/";

test("data URL commas stay inside the URL and trailing commas are stripped", () => {
  const parsed = parseSrcset(
    "data:image/png;base64,AAAA, data:image/png;base64,BBBB 2x",
    base,
  );

  assert.equal(parsed.issue, null);
  assert.equal(parsed.candidates.length, 2);
  assert.equal(parsed.candidates[0].url, "data:image/png;base64,AAAA");
  assert.equal(parsed.candidates[0].descriptor.kind, "x");
  assert.equal(parsed.candidates[0].descriptor.value.toString(), "1");
  assert.equal(parsed.candidates[0].raw, "data:image/png;base64,AAAA,");
  assert.equal(
    parsed.candidates[1].url,
    "data:image/png;base64,BBBB",
  );
  assert.equal(parsed.candidates[1].descriptor.value.toString(), "2");
  assert.equal(
    parsed.candidates[1].raw,
    "data:image/png;base64,BBBB 2x",
  );
});

test("a URL ending in commas is one descriptor-less candidate", () => {
  const parsed = parseSrcset("a.png,,, b.png 2x", base);

  assert.equal(parsed.candidates.length, 2);
  assert.equal(
    parsed.candidates[0].url,
    "https://cdn.example.test/images/a.png",
  );
  assert.equal(parsed.candidates[0].raw, "a.png,,,");
  assert.equal(parsed.candidates[0].range.start, 0);
  assert.equal(parsed.candidates[0].range.end, 8);
  assert.equal(parsed.candidates[0].range.byteEnd, 8);
  assert.equal(parsed.candidates[0].descriptor.value.toString(), "1");
  assert.equal(parsed.candidates[1].raw, "b.png 2x");
});

test("internal URL commas are not candidate separators", () => {
  const parsed = parseSrcset("path,with,commas.png 2x, other.png 1x", base);

  assert.equal(parsed.candidates.length, 2);
  assert.equal(
    parsed.candidates[0].url,
    "https://cdn.example.test/images/path,with,commas.png",
  );
  assert.equal(parsed.candidates[0].descriptor.value.toString(), "2");
  assert.equal(parsed.candidates[1].descriptor.value.toString(), "1");
});

test("an omitted descriptor is 1x and is preserved in original ranges", () => {
  const parsed = parseSrcset("only.png", base);

  assert.equal(parsed.candidates.length, 1);
  assert.equal(parsed.candidates[0].descriptor.text, "1x");
  assert.equal(parsed.candidates[0].range.start, 0);
  assert.equal(parsed.candidates[0].range.end, 8);
  assert.equal(parsed.candidates[0].raw, "only.png");
});

test("invalid candidates are discarded with a byte range and scanning continues", () => {
  const parsed = parseSrcset(
    "good-2x.png 2x, zero-w.png 0w, bad-width.png 1.5w, exp-x.png 1e2x, many.png 2x 3x, good-1x.png 1x",
    base,
  );

  assert.equal(parsed.issue, null);
  assert.deepEqual(
    parsed.candidates.map((candidate) => candidate.urlRaw),
    ["good-2x.png", "good-1x.png"],
  );
  assert.deepEqual(
    parsed.discarded.map((entry) => entry.reason),
    [
      "non-positive-descriptor",
      "invalid-width-descriptor",
      "invalid-density-descriptor",
      "multiple-descriptors",
    ],
  );
  for (const entry of parsed.discarded) {
    assert.ok(entry.range.end > entry.range.start);
    assert.ok(entry.range.byteEnd >= entry.range.byteStart);
    assert.equal(entry.raw.length, entry.range.end - entry.range.start);
  }
});

test("URL resolution errors only discard that candidate", () => {
  const parsed = parseSrcset("http://[ 3x, recovered.png 1x", base);

  assert.equal(parsed.candidates.length, 1);
  assert.equal(
    parsed.candidates[0].url,
    "https://cdn.example.test/images/recovered.png",
  );
  assert.equal(parsed.discarded.length, 1);
  assert.equal(parsed.discarded[0].reason, "invalid-url");
});

test("duplicate density descriptor values keep the earliest candidate", () => {
  const parsed = parseSrcset("a.png 1x, b.png 2x, c.png 2.0x, d.png 03x", base);

  assert.deepEqual(
    parsed.candidates.map((candidate) => candidate.urlRaw),
    ["a.png", "b.png", "d.png"],
  );
  assert.deepEqual(
    parsed.discarded.map((entry) => entry.raw),
    ["c.png 2.0x"],
  );
  assert.equal(parsed.discarded[0].reason, "duplicate-descriptor");
});

test("duplicate width descriptor values keep the earliest candidate", () => {
  const parsed = parseSrcset("e.png 100w, f.png 0100w, g.png 200w", base);

  assert.deepEqual(
    parsed.candidates.map((candidate) => candidate.urlRaw),
    ["e.png", "g.png"],
  );
  assert.equal(parsed.discarded[0].reason, "duplicate-descriptor");
});

test("a set mixing w and x descriptors is unusable", () => {
  const parsed = parseSrcset("width.png 100w, density.png 2x", base);

  assert.equal(parsed.candidates.length, 2);
  assert.equal(parsed.issue?.reason, "mixed-descriptor-types");
});

test("an empty candidate set is not usable", () => {
  const parsed = parseSrcset("bad.png 0w, worse.png 1.5w", base);

  assert.equal(parsed.candidates.length, 0);
  assert.equal(parsed.issue?.reason, "empty-candidate-set");
  assert.equal(parsed.discarded.length, 2);
});

test("ranges use UTF-16 indices and UTF-8 byte offsets", () => {
  const parsed = parseSrcset("图片.png 2x, ascii.png 1x", base);

  assert.equal(parsed.candidates.length, 2);
  assert.equal(parsed.candidates[0].range.start, 0);
  assert.equal(parsed.candidates[0].range.end, 9);
  assert.equal(parsed.candidates[0].range.byteEnd, 13);
  assert.equal(parsed.candidates[1].range.start, 11);
  assert.equal(parsed.candidates[1].range.byteStart, 15);
});

test("exact rational descriptor values compare without floating point drift", () => {
  const parsed = parseSrcset("a.png 1.0x, b.png 2.50x", base);

  assert.ok(parsed.candidates[1].densityValue.equals(Rational.from("2.5")));
  assert.equal(parsed.candidates[1].densityValue.toString(), "5/2");
});
