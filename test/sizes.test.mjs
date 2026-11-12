import test from "node:test";
import assert from "node:assert/strict";

import {
  Rational,
  evaluateSizeExpression,
  selectSlotWidth,
} from "../dist/index.js";

const viewport = Rational.from("1000");

test("external rational inputs accept decimal and fraction forms exactly", () => {
  assert.equal(Rational.from(".5").toString(), "1/2");
  assert.equal(Rational.from("1.").toString(), "1");
  assert.equal(Rational.from("1/3").toString(), "1/3");
  assert.equal(Rational.from({ numerator: 2, denominator: 3 }).toString(), "2/3");
  assert.equal(Rational.from(7n).toString(), "7");
});

test("px and vw lengths, left-associative operators, and parentheses", () => {
  const cases = [
    ["100px", "100"],
    ["50vw", "500"],
    ["10px + 5px - 2px", "13"],
    ["10px - (20px - 30px)", "20"],
    ["(10px)", "10"],
    ["0px + 5.25px", "21/4"],
  ];

  for (const [expression, expected] of cases) {
    const result = evaluateSizeExpression(expression, viewport);
    assert.equal(result.ok, true, expression);
    assert.equal(result.value.toString(), expected, expression);
  }
});

test("nested min/max and negative intermediates use exact rationals", () => {
  const cases = [
    ["min(10px, max(20px, 15px))", "10"],
    ["max(10px, min(20px, 5px) + 7px)", "12"],
    ["min(10px, 20px, 30px)", "10"],
    ["max(10px, 20px, 30px)", "30"],
    ["max(10px - 20px, 5px)", "5"],
    ["min(10px - 20px, 5px) + 15px", "5"],
    ["min(10px, 20px) + 5px", "15"],
  ];

  for (const [expression, expected] of cases) {
    const result = evaluateSizeExpression(expression, viewport);
    assert.equal(result.ok, true, expression);
    assert.equal(result.value.toString(), expected, expression);
  }
});

test("vw is an exact percentage of a rational viewport", () => {
  const result = evaluateSizeExpression("50vw", "1001/2");

  assert.equal(result.ok, true);
  assert.equal(result.value.toString(), "1001/4");
  assert.equal(result.value.toNumber(), 250.25);
});

test("invalid expressions are rejected deterministically", () => {
  const cases = [
    ["", "empty-expression"],
    ["-10px", "unsupported-unary-sign"],
    ["+10px", "unsupported-unary-sign"],
    ["10px + -2px", "unsupported-unary-sign"],
    ["10px + +5px", "unsupported-unary-sign"],
    ["10em", "unsupported-unit"],
    ["10vh", "unsupported-unit"],
    ["10", "missing-unit"],
    [".5px", "invalid-syntax"],
    ["1.px", "invalid-number"],
    ["min(10px)", "invalid-function-arguments"],
    ["min()", "invalid-function-arguments"],
    ["min(10px,)", "invalid-function-arguments"],
    ["calc(10px)", "unsupported-function"],
    ["10px - 20px", "non-positive-result"],
    ["max(10px, 5px) - 20px", "non-positive-result"],
  ];

  for (const [expression, reason] of cases) {
    const result = evaluateSizeExpression(expression, viewport);
    assert.equal(result.ok, false, expression);
    assert.equal(result.reason, reason, expression);
  }

  for (const expression of [
    "10px * 2",
    "10px / 2",
    "10px 5px",
    "min(10px, 20px) * 2",
    "10px + 5px * 2",
    "(10px",
    "10px)",
    "1e2px",
  ]) {
    assert.equal(evaluateSizeExpression(expression, viewport).ok, false, expression);
  }
});

test("sizes entries choose the first matching media with a valid positive expression", () => {
  const entries = [
    { media: "(min-width: 1000px)", expression: "50vw" },
    { media: "(min-width: 600px)", expression: "10em" },
    { media: "(min-width: 600px)", expression: "25vw" },
    { expression: "100px" },
  ];
  const mediaMatches = (media) => {
    const match = /^\(min-width: (\d+)px\)$/.exec(media);
    return match === null
      ? false
      : Rational.from("800").compare(Rational.from(match[1])) >= 0;
  };

  const result = selectSlotWidth(entries, "800", mediaMatches);

  assert.equal(result.entryIndex, 2);
  assert.equal(result.entry.expression, "25vw");
  assert.equal(result.slotWidth.toString(), "200");
  assert.equal(result.usedViewportFallback, false);
  assert.deepEqual(
    result.issues.map((entry) => entry.reason),
    ["media-no-match", "unsupported-unit"],
  );
});

test("sizes fall back to the viewport when no entry is usable", () => {
  const result = selectSlotWidth(
    [
      { media: "(max-width: 500px)", expression: "10px" },
      { media: "(min-width: 900px)", expression: "10px - 20px" },
    ],
    "800",
    () => false,
  );

  assert.equal(result.entryIndex, null);
  assert.equal(result.usedViewportFallback, true);
  assert.equal(result.slotWidth.toString(), "800");
});

test("an empty sizes list uses the viewport width", () => {
  const result = selectSlotWidth([], "640", () => true);

  assert.equal(result.entryIndex, null);
  assert.equal(result.slotWidth.toString(), "640");
  assert.equal(result.issues.length, 0);
});
