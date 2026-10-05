import { test } from "node:test";
import assert from "node:assert/strict";
import {
  replaceAll,
  ReplaceSession,
  InvalidCaptureError,
  BudgetExceededError,
} from "../src/index.js";
import { labelSource, referenceReplace } from "../src/reference.js";
import {
  mulberry32,
  randInt,
  randomText,
  randomMatches,
  randomTemplate,
  expectedRanges,
} from "./util.js";

const ITERATIONS = 300;

test("random single rounds match the piecewise reference interpreter", () => {
  const rng = mulberry32(0x5eed);
  for (let iter = 0; iter < ITERATIONS; iter++) {
    const source = randomText(rng);
    const groupCount = randInt(rng, 0, 2);
    const matches = randomMatches(rng, source, groupCount);
    const template = randomTemplate(rng, groupCount);

    const actual = replaceAll(source, matches, template);
    const expected = referenceReplace(labelSource(source), matches, template);

    assert.equal(actual.text, expected.text, `text mismatch at iter ${iter}`);
    assert.equal(actual.map.outputLength, expected.text.length);
    for (let p = 0; p < expected.text.length; p++) {
      const want = expected.labels[p] === -1 ? null : expected.labels[p];
      assert.equal(
        actual.map.sourcePositionAt(p),
        want,
        `forward map mismatch at iter ${iter}, pos ${p}`,
      );
    }
    for (let s = 0; s < source.length; s++) {
      assert.deepEqual(
        actual.map.outputRangesForSource(s),
        expectedRanges(expected.labels, s),
        `inverse map mismatch at iter ${iter}, source pos ${s}`,
      );
    }
  }
});

test("random three-round sessions match direct source-label propagation", () => {
  const rng = mulberry32(0xc0ffee);
  for (let iter = 0; iter < ITERATIONS; iter++) {
    const source = randomText(rng);
    const session = new ReplaceSession(source);
    let labelled = labelSource(source);

    for (let round = 0; round < 3; round++) {
      const groupCount = randInt(rng, 0, 2);
      const matches = randomMatches(rng, session.text, groupCount);
      const template = randomTemplate(rng, groupCount);
      session.apply(matches, template);
      labelled = referenceReplace(labelled, matches, template);
      assert.equal(
        session.text,
        labelled.text,
        `text mismatch at iter ${iter}, round ${round}`,
      );
    }

    // Forward: every output position resolves to its propagated label.
    for (let p = 0; p < labelled.text.length; p++) {
      const want = labelled.labels[p] === -1 ? null : labelled.labels[p];
      assert.equal(
        session.sourcePositionAt(p),
        want,
        `composed forward mismatch at iter ${iter}, pos ${p}`,
      );
    }
    // Inverse: every source position yields exactly the expected ranges.
    for (let s = 0; s < source.length; s++) {
      assert.deepEqual(
        session.outputRangesForSource(s),
        expectedRanges(labelled.labels, s),
        `composed inverse mismatch at iter ${iter}, source pos ${s}`,
      );
    }
  }
});

test("random invalid references reject the operation without modification", () => {
  const rng = mulberry32(0xbad);
  for (let iter = 0; iter < 100; iter++) {
    const source = randomText(rng);
    const groupCount = randInt(rng, 0, 2);
    const matches = randomMatches(rng, source, groupCount);
    if (matches.length === 0) continue;
    const session = new ReplaceSession(source);
    const before = session.text;
    assert.throws(
      () => session.apply(matches, `$${groupCount + 1}`),
      InvalidCaptureError,
    );
    assert.equal(session.text, before);
    assert.equal(session.depth, 0);
  }
});

test("random budget failures leave the session untouched", () => {
  const rng = mulberry32(0xb1b);
  for (let iter = 0; iter < 100; iter++) {
    const source = randomText(rng);
    const groupCount = randInt(rng, 0, 2);
    const matches = randomMatches(rng, source, groupCount);
    const template = randomTemplate(rng, groupCount);
    const full = replaceAll(source, matches, template);
    if (full.text.length === 0) continue;

    const session = new ReplaceSession(source);
    const budget = randInt(rng, 0, full.text.length - 1);
    assert.throws(
      () => session.apply(matches, template, { budget }),
      BudgetExceededError,
    );
    assert.equal(session.text, source);
    assert.equal(session.depth, 0);
    // The same round with sufficient budget succeeds.
    session.apply(matches, template, { budget: full.text.length });
    assert.equal(session.text, full.text);
  }
});
