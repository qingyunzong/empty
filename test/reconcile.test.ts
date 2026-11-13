// @ts-nocheck
import test from "node:test";
import assert from "node:assert/strict";

import {
  createCurrencyPolicy,
  reconcile,
  reconcileLineItems,
  type InvoiceDocument,
  type InvoiceLine,
} from "../index.js";

const strictPolicy = createCurrencyPolicy({
  code: "XTS",
  tolerance: 0,
  rateTolerance: 0,
});

function lines(amounts: number[], name = "item"): InvoiceLine[] {
  return amounts.map((amount) => ({ name, amount }));
}

test("identical documents reconcile without discrepancies", () => {
  const expected: InvoiceDocument = {
    lines: [
      { name: "牛奶", amount: 1_250, taxRate: 0.13 },
      { name: "面包", amount: 800, taxRate: 0.13 },
    ],
    subtotal: 2_050,
    tax: 267,
    total: 2_317,
  };
  const observed: InvoiceDocument = JSON.parse(JSON.stringify(expected));

  const result = reconcile(expected, observed, strictPolicy);
  assert.equal(result.ok, true);
  assert.deepEqual(result.discrepancies, []);
  assert.equal(result.matches.length, 2);
  assert.deepEqual(result.summary.derived.expected, {
    subtotal: 2_050,
    discount: 0,
    tax: undefined,
    total: undefined,
  });
});

test("currency policy controls absolute rounding allowances", () => {
  const expected = lines([100, 200]);
  const observed = lines([101, 200]);

  const rounded = createCurrencyPolicy({
    code: "XTS",
    lineTolerance: 1,
    taxTolerance: 0,
    discountTolerance: 0,
  });
  assert.equal(reconcileLineItems(expected, observed, rounded).ok, true);

  const strict = reconcileLineItems(expected, observed, strictPolicy);
  assert.equal(strict.discrepancies.length, 1);
  assert.equal(strict.discrepancies[0].kind, "line-amount");
  assert.equal(strict.discrepancies[0].delta, 1);
});

test("same-name duplicates match by amount even when OCR order changes", () => {
  const expected: InvoiceLine[] = [
    { name: "咖啡", amount: 1_200 },
    { name: "咖啡", amount: 1_800 },
  ];
  const observed: InvoiceLine[] = [
    { name: "咖啡", amount: 1_800 },
    { name: "咖啡", amount: 1_200 },
  ];

  const result = reconcileLineItems(expected, observed, strictPolicy);
  assert.equal(result.ok, true);
  assert.deepEqual(
    result.matches.map((match) => [match.expectedIndex, match.observedIndex]),
    [
      [0, 1],
      [1, 0],
    ],
  );
});

test("position resolves same-name, same-amount ties", () => {
  const expected: InvoiceLine[] = [
    { name: "纸巾", amount: 500, position: 0 },
    { name: "纸巾", amount: 500, position: 1 },
  ];
  const observed: InvoiceLine[] = [
    { name: "纸巾", amount: 500, position: 1 },
    { name: "纸巾", amount: 500, position: 0 },
  ];
  const result = reconcileLineItems(expected, observed, strictPolicy);
  assert.deepEqual(
    result.matches.map((match) => [match.expectedIndex, match.observedIndex]),
    [
      [0, 1],
      [1, 0],
    ],
  );
});

test("duplicate-name matching returns only the minimum missing line", () => {
  const expected = lines([100, 200], "套餐");
  const observed = lines([100], "套餐");
  const result = reconcileLineItems(expected, observed, strictPolicy);

  assert.equal(result.discrepancies.length, 1);
  assert.equal(result.discrepancies[0].kind, "line-missing");
  assert.equal(result.discrepancies[0].expectedIndex, 1);
});

test("tax, discount and summary mismatches are reported", () => {
  const expected: InvoiceDocument = {
    lines: [
      {
        name: "套餐",
        amount: 10_000,
        taxRate: 0.13,
        taxAmount: 1_300,
        discount: 1_000,
      },
    ],
    subtotal: 10_000,
    discount: 1_000,
    tax: 1_300,
    total: 10_300,
  };
  const observed: InvoiceDocument = {
    lines: [
      {
        name: "套餐",
        amount: 10_000,
        taxRate: 0.12,
        taxAmount: 1_100,
        discount: 900,
      },
    ],
    subtotal: 10_000,
    discount: 900,
    tax: 1_100,
    total: 10_200,
  };

  const result = reconcile(expected, observed, strictPolicy);
  assert.deepEqual(
    result.discrepancies.map((issue) => issue.kind),
    [
      "line-tax-rate",
      "line-tax-amount",
      "line-discount",
      "summary-discount",
      "summary-tax",
      "summary-total",
    ],
  );
});

test("a summary mismatch is not duplicated as an arithmetic issue", () => {
  const expected: InvoiceDocument = {
    lines: [{ name: "item", amount: 100, taxAmount: 10 }],
    subtotal: 100,
    tax: 10,
    total: 110,
  };
  const observed: InvoiceDocument = {
    lines: [{ name: "item", amount: 100, taxAmount: 10 }],
    subtotal: 100,
    tax: 10,
    total: 111,
  };
  const result = reconcile(expected, observed, strictPolicy);
  assert.equal(result.discrepancies.length, 1);
  assert.equal(result.discrepancies[0].kind, "summary-total");
});

test("summary arithmetic is checked when both documents agree", () => {
  const expected: InvoiceDocument = {
    lines: [{ name: "item", amount: 100, taxAmount: 10 }],
    subtotal: 100,
    tax: 10,
    total: 111,
  };
  const observed: InvoiceDocument = JSON.parse(JSON.stringify(expected));
  const result = reconcile(expected, observed, strictPolicy, {
    checkSummaryArithmetic: true,
  });

  assert.equal(result.discrepancies.length, 2);
  assert.deepEqual(
    result.discrepancies.map((issue) => issue.side),
    ["expected", "observed"],
  );
});

test("tax entries match by rate and compare amounts", () => {
  const expected: InvoiceDocument = {
    lines: [{ name: "item", amount: 100 }],
    taxes: [{ rate: "13%", amount: 13 }],
  };
  const observed: InvoiceDocument = {
    lines: [{ name: "item", amount: 100 }],
    taxes: [{ rate: 0.13001, amount: 14 }],
  };
  const policy = createCurrencyPolicy({
    code: "XTS",
    tolerance: 0,
    rateTolerance: 0.00005,
  });

  const result = reconcile(expected, observed, policy);
  assert.equal(result.discrepancies.length, 1);
  assert.equal(result.discrepancies[0].kind, "tax-entry-amount");
  assert.equal(result.discrepancies[0].rate, 0.13);
});

test("non-integer minor-unit amounts are rejected", () => {
  assert.throws(
    () =>
      reconcileLineItems(
        [{ name: "item", amount: 10.5 }],
        [{ name: "item", amount: 10 }],
        strictPolicy,
      ),
    /integer number of minor units/,
  );
});

test("common ETL field aliases are accepted", () => {
  const expected = {
    currency: "CNY",
    lineItems: [
      { name: "item", amountMinor: 100, taxRateBps: 1300 },
    ],
    subTotal: 100,
    taxTotal: 13,
    grandTotal: 113,
  };
  const observed = {
    items: [
      { description: "item", totalAmount: 100, taxRate: "13%" },
    ],
    summary: { subTotal: 100, taxTotal: 13, grandTotal: 113 },
  };
  assert.equal(reconcile(expected, observed, "CNY").ok, true);
});

interface OracleScore {
  mismatches: number;
  positionDistance: number;
  amountDistance: number;
}

function compareScores(a: OracleScore, b: OracleScore): number {
  if (a.mismatches !== b.mismatches) return a.mismatches - b.mismatches;
  if (a.positionDistance !== b.positionDistance) {
    return a.positionDistance - b.positionDistance;
  }
  return a.amountDistance - b.amountDistance;
}

function bestExhaustiveAssignment(
  expected: number[],
  observed: number[],
  tolerance: number,
): { score: OracleScore; issues: number } {
  const pairCount = Math.min(expected.length, observed.length);
  let best: OracleScore | undefined;

  const visit = (row: number, used: boolean[], score: OracleScore, pairs: number) => {
    if (pairs === pairCount) {
      if (!best || compareScores(score, best) < 0) best = score;
      return;
    }
    const remainingRows = expected.length - row;
    if (remainingRows < pairCount - pairs) return;

    if (row < expected.length) {
      for (let column = 0; column < observed.length; column += 1) {
        if (used[column]) continue;
        used[column] = true;
        const delta = Math.abs(expected[row] - observed[column]);
        visit(
          row + 1,
          used,
          {
            mismatches: score.mismatches + (delta > tolerance ? 1 : 0),
            positionDistance: score.positionDistance + Math.abs(row - column),
            amountDistance: score.amountDistance + delta,
          },
          pairs + 1,
        );
        used[column] = false;
      }
    }

    if (expected.length - row - 1 >= pairCount - pairs) {
      visit(row + 1, used, score, pairs);
    }
  };

  visit(0, Array(observed.length).fill(false), {
    mismatches: 0,
    positionDistance: 0,
    amountDistance: 0,
  }, 0);

  if (!best) {
    return {
      score: { mismatches: 0, positionDistance: 0, amountDistance: 0 },
      issues: expected.length + observed.length,
    };
  }
  return {
    score: best,
    issues:
      expected.length +
      observed.length -
      pairCount * 2 +
      best.mismatches,
  };
}

function amountArrays(maxLength: number, values: number[]): number[][] {
  const result: number[][] = [];
  const build = (prefix: number[]) => {
    result.push(prefix);
    if (prefix.length === maxLength) return;
    for (const value of values) build([...prefix, value]);
  };
  build([]);
  return result;
}

test("small instances match an exhaustive assignment oracle", () => {
  const arrays = amountArrays(3, [100, 101, 103]);
  for (const tolerance of [0, 1]) {
    const policy = createCurrencyPolicy({
      code: "XTS",
      lineTolerance: tolerance,
      taxTolerance: 0,
      discountTolerance: 0,
    });
    for (const expected of arrays) {
      for (const observed of arrays) {
        const result = reconcileLineItems(
          lines(expected, "duplicate"),
          lines(observed, "duplicate"),
          policy,
        );
        const oracle = bestExhaustiveAssignment(expected, observed, tolerance);
        assert.equal(
          result.discrepancies.length,
          oracle.issues,
          `issue count for ${expected.join(",")} vs ${observed.join(",")}`,
        );
        const actualScore = result.matches.reduce<OracleScore>(
          (score, match) => ({
            mismatches:
              score.mismatches +
              (Math.abs(
                (match.expected as InvoiceLine).amount -
                  (match.observed as InvoiceLine).amount,
              ) > tolerance
                ? 1
                : 0),
            positionDistance:
              score.positionDistance + match.positionDistance,
            amountDistance: score.amountDistance + match.amountDistance,
          }),
          { mismatches: 0, positionDistance: 0, amountDistance: 0 },
        );
        assert.deepEqual(
          actualScore,
          oracle.score,
          `assignment for ${expected.join(",")} vs ${observed.join(",")}`,
        );
      }
    }
  }
});

interface Variant {
  amount: number;
  taxRate: number;
  discount: number;
}

function bestFieldAssignment(
  expected: Variant[],
  observed: Variant[],
): OracleScore {
  const pairCount = Math.min(expected.length, observed.length);
  let best: OracleScore | undefined;

  const visit = (
    row: number,
    used: boolean[],
    score: OracleScore,
    pairs: number,
  ) => {
    if (pairs === pairCount) {
      if (!best || compareScores(score, best) < 0) best = score;
      return;
    }
    if (expected.length - row < pairCount - pairs) return;

    if (row < expected.length) {
      for (let column = 0; column < observed.length; column += 1) {
        if (used[column]) continue;
        used[column] = true;
        const left = expected[row];
        const right = observed[column];
        visit(
          row + 1,
          used,
          {
            mismatches:
              score.mismatches +
              (left.amount !== right.amount ? 1 : 0) +
              (left.taxRate !== right.taxRate ? 1 : 0) +
              (left.discount !== right.discount ? 1 : 0),
            positionDistance:
              score.positionDistance + Math.abs(row - column),
            amountDistance:
              score.amountDistance + Math.abs(left.amount - right.amount),
          },
          pairs + 1,
        );
        used[column] = false;
      }
    }
    if (expected.length - row - 1 >= pairCount - pairs) {
      visit(row + 1, used, score, pairs);
    }
  };

  visit(
    0,
    Array(observed.length).fill(false),
    { mismatches: 0, positionDistance: 0, amountDistance: 0 },
    0,
  );
  return best!;
}

function variantArrays(maxLength: number): Variant[][] {
  const variants: Variant[] = [];
  for (const amount of [100, 102]) {
    for (const taxRate of [0, 0.13]) {
      for (const discount of [0, 5]) {
        variants.push({ amount, taxRate, discount });
      }
    }
  }
  const result: Variant[][] = [];
  const build = (prefix: Variant[]) => {
    result.push(prefix);
    if (prefix.length === maxLength) return;
    for (const variant of variants) build([...prefix, variant]);
  };
  build([]);
  return result;
}

test("multi-field exhaustive oracle agrees on assignment and issue count", () => {
  const policy = createCurrencyPolicy({
    code: "XTS",
    tolerance: 0,
    rateTolerance: 0,
  });
  const arrays = variantArrays(2);

  for (const expected of arrays) {
    for (const observed of arrays) {
      const toLine = (variant: Variant): InvoiceLine => ({
        name: "duplicate",
        amount: variant.amount,
        taxRate: variant.taxRate,
        discount: variant.discount,
      });
      const result = reconcileLineItems(
        expected.map(toLine),
        observed.map(toLine),
        policy,
      );
      const oracle = bestFieldAssignment(expected, observed);
      const pairCount = Math.min(expected.length, observed.length);
      assert.equal(
        result.discrepancies.length,
        expected.length + observed.length - pairCount * 2 + oracle.mismatches,
      );
      const actualScore = result.matches.reduce<OracleScore>(
        (score, match) => {
          const left = match.expected;
          const right = match.observed;
          return {
            mismatches:
              score.mismatches +
              (left.amount !== right.amount ? 1 : 0) +
              ((left.taxRate ?? 0) !== (right.taxRate ?? 0) ? 1 : 0) +
              ((typeof left.discount === "number" ? left.discount : 0) !==
              (typeof right.discount === "number" ? right.discount : 0)
                ? 1
                : 0),
            positionDistance:
              score.positionDistance + match.positionDistance,
            amountDistance:
              score.amountDistance +
              Math.abs((left.amount ?? 0) - (right.amount ?? 0)),
          };
        },
        { mismatches: 0, positionDistance: 0, amountDistance: 0 },
      );
      assert.deepEqual(actualScore, oracle);
    }
  }
});
