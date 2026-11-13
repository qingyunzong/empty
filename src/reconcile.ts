import { minimumCostAssignment } from "./assign.js";
import {
  createCurrencyPolicy,
  DEFAULT_CURRENCY_POLICY,
  resolveTolerance,
} from "./policy.js";
import {
  normalizeDocument,
  type NormalizedDocument,
  type NormalizedLine,
  type NormalizedTaxEntry,
} from "./normalize.js";
import type {
  CurrencyPolicy,
  CurrencyPolicyInput,
  Discrepancy,
  DiscrepancyKind,
  InvoiceDocument,
  InvoiceLine,
  InvoiceTotals,
  LineMatch,
  ReconcileOptions,
  ReconcileRequest,
  ReconciliationResult,
  SummaryReconciliation,
  ToleranceRule,
  ToleranceScope,
} from "./types.js";

const RATE_EPSILON = 1e-12;

const DEFAULT_OPTIONS: Required<ReconcileOptions> = {
  checkSummaryArithmetic: true,
  compareTaxEntries: true,
  compareQuantities: true,
  compareUnitAmounts: true,
  compareSkus: true,
  caseSensitiveNames: false,
  requireIntegerAmounts: true,
};

interface FieldDifference {
  kind: DiscrepancyKind;
  field: string;
  expected: number | string;
  observed: number | string;
  delta?: number;
  tolerance?: number;
  isRate?: boolean;
}

interface PairEvaluation {
  differences: FieldDifference[];
  positionDistance: number;
  amountDistance: number;
}

interface TaxBucket {
  rate: number;
  amount: number;
  taxable: number | null;
}

function isDocument(value: unknown): value is InvoiceDocument {
  return (
    typeof value === "object" &&
    value !== null &&
    (Array.isArray((value as InvoiceDocument).lines) ||
      Array.isArray((value as InvoiceDocument).lineItems) ||
      Array.isArray((value as InvoiceDocument).items))
  );
}

function isRequest(value: unknown): value is ReconcileRequest {
  return (
    typeof value === "object" &&
    value !== null &&
    "expected" in value &&
    !("lines" in value)
  );
}

function asDocument(value: InvoiceDocument | readonly InvoiceLine[]): InvoiceDocument {
  if (Array.isArray(value)) {
    return { lines: value as readonly InvoiceLine[] };
  }
  const document = value as InvoiceDocument;
  const lineItems = document.lines ?? document.lineItems ?? document.items;
  return document.lines
    ? document
    : { ...document, lines: lineItems ?? [] };
}

function tolerance(
  rule: ToleranceRule,
  scope: ToleranceScope,
  expected: number,
  observed: number,
  policy: CurrencyPolicy,
  lineCount: number,
): number {
  return resolveTolerance(rule, {
    currency: policy.code,
    scope,
    expected,
    observed,
    lineCount,
  });
}

function pushDifference(
  differences: FieldDifference[],
  kind: DiscrepancyKind,
  field: string,
  expected: number,
  observed: number,
  allowed: number,
  isRate = false,
): void {
  const slack = isRate ? RATE_EPSILON : 0;
  if (Math.abs(expected - observed) <= allowed + slack) return;
  differences.push({
    kind,
    field,
    expected,
    observed,
    delta: observed - expected,
    tolerance: allowed,
    isRate,
  });
}

function evaluatePair(
  expected: NormalizedLine,
  observed: NormalizedLine,
  policy: CurrencyPolicy,
  options: Required<ReconcileOptions>,
  lineCount: number,
): PairEvaluation {
  const differences: FieldDifference[] = [];

  pushDifference(
    differences,
    "line-amount",
    "amount",
    expected.amount,
    observed.amount,
    tolerance(
      policy.lineTolerance,
      "line-amount",
      expected.amount,
      observed.amount,
      policy,
      lineCount,
    ),
  );

  if (options.compareUnitAmounts && expected.unitAmount !== null && observed.unitAmount !== null) {
    pushDifference(
      differences,
      "line-unit-amount",
      "unitAmount",
      expected.unitAmount,
      observed.unitAmount,
      tolerance(
        policy.unitAmountTolerance,
        "unit-amount",
        expected.unitAmount,
        observed.unitAmount,
        policy,
        lineCount,
      ),
    );
  }

  if (options.compareQuantities && expected.quantity !== null && observed.quantity !== null) {
    pushDifference(
      differences,
      "line-quantity",
      "quantity",
      expected.quantity,
      observed.quantity,
      tolerance(
        policy.quantityTolerance,
        "quantity",
        expected.quantity,
        observed.quantity,
        policy,
        lineCount,
      ),
    );
  }

  if (expected.taxRate !== null || observed.taxRate !== null) {
    const expectedRate = expected.taxRate ?? 0;
    const observedRate = observed.taxRate ?? 0;
    pushDifference(
      differences,
      "line-tax-rate",
      "taxRate",
      expectedRate,
      observedRate,
      tolerance(
        policy.taxRateTolerance,
        "tax-rate",
        expectedRate,
        observedRate,
        policy,
        lineCount,
      ),
      true,
    );
  }

  if (expected.taxAmount !== null || observed.taxAmount !== null) {
    const expectedTax = expected.taxAmount ?? 0;
    const observedTax = observed.taxAmount ?? 0;
    pushDifference(
      differences,
      "line-tax-amount",
      "taxAmount",
      expectedTax,
      observedTax,
      tolerance(
        policy.taxTolerance,
        "tax-amount",
        expectedTax,
        observedTax,
        policy,
        lineCount,
      ),
    );
  }

  if (expected.discountAmount !== null || observed.discountAmount !== null) {
    const expectedDiscount = expected.discountAmount ?? 0;
    const observedDiscount = observed.discountAmount ?? 0;
    pushDifference(
      differences,
      "line-discount",
      "discount",
      expectedDiscount,
      observedDiscount,
      tolerance(
        policy.discountTolerance,
        "discount-amount",
        expectedDiscount,
        observedDiscount,
        policy,
        lineCount,
      ),
    );
  }

  if (expected.discountRate !== null || observed.discountRate !== null) {
    const expectedRate = expected.discountRate ?? 0;
    const observedRate = observed.discountRate ?? 0;
    pushDifference(
      differences,
      "line-discount-rate",
      "discountRate",
      expectedRate,
      observedRate,
      tolerance(
        policy.discountRateTolerance,
        "discount-rate",
        expectedRate,
        observedRate,
        policy,
        lineCount,
      ),
      true,
    );
  }

  if (options.compareSkus && expected.sku !== null && observed.sku !== null && expected.sku !== observed.sku) {
    differences.push({
      kind: "line-sku",
      field: "sku",
      expected: expected.sku,
      observed: observed.sku,
    });
  }

  return {
    differences,
    positionDistance: Math.abs(expected.position - observed.position),
    amountDistance: Math.abs(expected.amount - observed.amount),
  };
}

function groupLines(lines: NormalizedLine[]): Map<string, NormalizedLine[]> {
  const groups = new Map<string, NormalizedLine[]>();
  for (const line of lines) {
    const group = groups.get(line.name);
    if (group) {
      group.push(line);
    } else {
      groups.set(line.name, [line]);
    }
  }
  return groups;
}

function lineMessage(difference: FieldDifference, expected: NormalizedLine): string {
  return `Line "${expected.name || `#${expected.index}`}" ${difference.field} differs by ${difference.delta ?? "an unmatched value"}`;
}

function lineDiscrepancy(
  difference: FieldDifference,
  expected: NormalizedLine,
  observed: NormalizedLine,
): Discrepancy {
  return {
    kind: difference.kind,
    scope: "line",
    field: difference.field,
    message: lineMessage(difference, expected),
    name: expected.name,
    expectedIndex: expected.index,
    observedIndex: observed.index,
    expectedId: expected.raw.id,
    observedId: observed.raw.id,
    position: expected.position,
    expected: difference.expected,
    observed: difference.observed,
    delta: difference.delta,
    tolerance: difference.tolerance,
    expectedLine: expected.raw,
    observedLine: observed.raw,
  };
}

function missingLineDiscrepancy(
  line: NormalizedLine,
  side: "expected" | "observed",
): Discrepancy {
  const missingObserved = side === "expected";
  return {
    kind: missingObserved ? "line-missing" : "line-unexpected",
    scope: "line",
    field: "line",
    message: missingObserved
      ? `Expected line "${line.name || `#${line.index}`}" has no OCR match`
      : `OCR line "${line.name || `#${line.index}`}" has no expected match`,
    name: line.name,
    expectedIndex: missingObserved ? line.index : undefined,
    observedIndex: missingObserved ? undefined : line.index,
    expectedId: missingObserved ? line.raw.id : undefined,
    observedId: missingObserved ? undefined : line.raw.id,
    position: line.position,
    expectedLine: missingObserved ? line.raw : undefined,
    observedLine: missingObserved ? undefined : line.raw,
    side,
  };
}

function matchDocumentLines(
  expected: NormalizedDocument,
  observed: NormalizedDocument,
  policy: CurrencyPolicy,
  options: Required<ReconcileOptions>,
): {
  matches: LineMatch[];
  unmatchedExpected: NormalizedLine[];
  unmatchedObserved: NormalizedLine[];
  discrepancies: Discrepancy[];
} {
  const expectedGroups = groupLines(expected.lines);
  const observedGroups = groupLines(observed.lines);
  const names = new Set([...expectedGroups.keys(), ...observedGroups.keys()]);
  const lineCount = Math.max(expected.lines.length, observed.lines.length);
  const matches: LineMatch[] = [];
  const unmatchedExpected: NormalizedLine[] = [];
  const unmatchedObserved: NormalizedLine[] = [];
  const discrepancies: Discrepancy[] = [];

  for (const name of names) {
    const left = expectedGroups.get(name) ?? [];
    const right = observedGroups.get(name) ?? [];
    const evaluations = left.map((leftLine) =>
      right.map((rightLine) =>
        evaluatePair(leftLine, rightLine, policy, options, lineCount),
      ),
    );
    const pairs = minimumCostAssignment(left.length, right.length, (row, column) => ({
      mismatches: evaluations[row][column].differences.length,
      positionDistance: evaluations[row][column].positionDistance,
      amountDistance: evaluations[row][column].amountDistance,
    }));

    const matchedLeft = new Set<number>();
    const matchedRight = new Set<number>();
    for (const [row, column] of pairs) {
      const leftLine = left[row];
      const rightLine = right[column];
      const evaluation = evaluations[row][column];
      matchedLeft.add(row);
      matchedRight.add(column);
      matches.push({
        expected: leftLine.raw,
        observed: rightLine.raw,
        actual: rightLine.raw,
        expectedIndex: leftLine.index,
        observedIndex: rightLine.index,
        name: leftLine.name,
        positionDistance: evaluation.positionDistance,
        amountDistance: evaluation.amountDistance,
        consistent: evaluation.differences.length === 0,
      });
      for (const difference of evaluation.differences) {
        discrepancies.push(lineDiscrepancy(difference, leftLine, rightLine));
      }
    }

    for (let row = 0; row < left.length; row += 1) {
      if (!matchedLeft.has(row)) {
        unmatchedExpected.push(left[row]);
        discrepancies.push(missingLineDiscrepancy(left[row], "expected"));
      }
    }
    for (let column = 0; column < right.length; column += 1) {
      if (!matchedRight.has(column)) {
        unmatchedObserved.push(right[column]);
        discrepancies.push(missingLineDiscrepancy(right[column], "observed"));
      }
    }
  }

  matches.sort((a, b) => a.expectedIndex - b.expectedIndex);
  unmatchedExpected.sort((a, b) => a.index - b.index);
  unmatchedObserved.sort((a, b) => a.index - b.index);
  return { matches, unmatchedExpected, unmatchedObserved, discrepancies };
}

function summaryDiscrepancy(
  field: keyof InvoiceTotals,
  expected: number | undefined,
  observed: number | undefined,
  delta: number | undefined,
  allowed: number | undefined,
): Discrepancy {
  const kind = `summary-${field}` as DiscrepancyKind;
  const expectedText = expected === undefined ? "missing" : String(expected);
  const observedText = observed === undefined ? "missing" : String(observed);
  return {
    kind,
    scope: "summary",
    field,
    message: `Summary ${field} expected ${expectedText}, observed ${observedText}`,
    expected,
    observed,
    delta,
    tolerance: allowed,
  };
}

function compareSummaries(
  expected: NormalizedDocument,
  observed: NormalizedDocument,
  policy: CurrencyPolicy,
  lineCount: number,
): { discrepancies: Discrepancy[]; comparedFields: Set<keyof InvoiceTotals> } {
  const fields: Array<[keyof InvoiceTotals, ToleranceRule, ToleranceScope]> = [
    ["subtotal", policy.subtotalTolerance, "subtotal"],
    ["discount", policy.discountTolerance, "discount"],
    ["tax", policy.taxTolerance, "tax"],
    ["total", policy.totalTolerance, "total"],
  ];
  const discrepancies: Discrepancy[] = [];
  const comparedFields = new Set<keyof InvoiceTotals>();

  for (const [field, rule, scope] of fields) {
    const left = expected.summary[field];
    const right = observed.summary[field];
    if (left === undefined && right === undefined) continue;

    if (left === undefined || right === undefined) {
      comparedFields.add(field);
      discrepancies.push(
        summaryDiscrepancy(field, left, right, undefined, undefined),
      );
      continue;
    }

    const allowed = tolerance(rule, scope, left, right, policy, lineCount);
    if (Math.abs(left - right) > allowed) {
      comparedFields.add(field);
      discrepancies.push(
        summaryDiscrepancy(field, left, right, right - left, allowed),
      );
    }
  }
  return { discrepancies, comparedFields };
}

function checkArithmetic(
  side: "expected" | "observed",
  document: NormalizedDocument,
  policy: CurrencyPolicy,
  lineCount: number,
  comparedFields: Set<keyof InvoiceTotals>,
): Discrepancy[] {
  const { summary, derived } = document;
  const discrepancies: Discrepancy[] = [];

  const add = (
    field: keyof InvoiceTotals,
    declared: number,
    computed: number,
    rule: ToleranceRule,
    scope: ToleranceScope,
  ) => {
    if (comparedFields.has(field)) return;
    const allowed = tolerance(rule, scope, computed, declared, policy, lineCount);
    if (Math.abs(computed - declared) <= allowed) return;
    discrepancies.push({
      kind: "summary-arithmetic",
      scope: "summary",
      field,
      side,
      message: `${side} ${field} ${declared} does not equal line-derived ${computed}`,
      expected: computed,
      observed: declared,
      delta: declared - computed,
      tolerance: allowed,
    });
  };

  if (summary.subtotal !== undefined) {
    add(
      "subtotal",
      summary.subtotal,
      derived.subtotal,
      policy.subtotalTolerance,
      "subtotal",
    );
  }
  const hasLineDiscounts = document.lines.some(
    (line) => line.discountAmount !== null || line.discountRate !== null,
  );
  if (summary.discount !== undefined && hasLineDiscounts) {
    add(
      "discount",
      summary.discount,
      derived.discount,
      policy.discountTolerance,
      "discount",
    );
  }
  if (summary.tax !== undefined && derived.tax !== undefined) {
    add("tax", summary.tax, derived.tax, policy.taxTolerance, "tax");
  }
  if (summary.total !== undefined) {
    const subtotal = summary.subtotal ?? derived.subtotal;
    const discount = summary.discount ?? derived.discount;
    const tax = summary.tax ?? derived.tax;
    const hasRates = document.lines.some((line) => line.taxRate !== null);
    if (tax !== undefined || !hasRates) {
      add(
        "total",
        summary.total,
        subtotal - discount + (tax ?? 0),
        policy.totalTolerance,
        "total",
      );
    }
  }

  return discrepancies;
}

function taxBuckets(entries: NormalizedTaxEntry[]): TaxBucket[] {
  const buckets = new Map<string, TaxBucket>();
  for (const entry of entries) {
    const key = entry.rate.toFixed(12);
    const bucket = buckets.get(key);
    if (bucket) {
      bucket.amount += entry.amount;
      bucket.taxable =
        bucket.taxable === null || entry.taxable === null
          ? null
          : bucket.taxable + entry.taxable;
    } else {
      buckets.set(key, {
        rate: entry.rate,
        amount: entry.amount,
        taxable: entry.taxable,
      });
    }
  }
  return [...buckets.values()].sort((a, b) => a.rate - b.rate);
}

function compareTaxEntries(
  expected: NormalizedDocument,
  observed: NormalizedDocument,
  policy: CurrencyPolicy,
  lineCount: number,
): Discrepancy[] {
  if (expected.taxes.length === 0 && observed.taxes.length === 0) return [];

  const left = taxBuckets(expected.taxes);
  const right = taxBuckets(observed.taxes);
  const usedRight = new Set<number>();
  const discrepancies: Discrepancy[] = [];

  for (const leftBucket of left) {
    let bestIndex = -1;
    let bestDistance = Number.POSITIVE_INFINITY;
    for (let index = 0; index < right.length; index += 1) {
      if (usedRight.has(index)) continue;
      const candidate = right[index];
      const distance = Math.abs(leftBucket.rate - candidate.rate);
      const allowed = tolerance(
        policy.taxRateTolerance,
        "tax-rate",
        leftBucket.rate,
        candidate.rate,
        policy,
        lineCount,
      );
      if (distance <= allowed + RATE_EPSILON && distance < bestDistance) {
        bestDistance = distance;
        bestIndex = index;
      }
    }

    if (bestIndex < 0) {
      discrepancies.push({
        kind: "tax-entry-missing",
        scope: "tax",
        field: "tax",
        rate: leftBucket.rate,
        expected: leftBucket.amount,
        message: `Missing OCR tax entry at rate ${leftBucket.rate}`,
      });
      continue;
    }

    usedRight.add(bestIndex);
    const rightBucket = right[bestIndex];
    const allowed = tolerance(
      policy.taxTolerance,
      "tax-entry-amount",
      leftBucket.amount,
      rightBucket.amount,
      policy,
      lineCount,
    );
    if (Math.abs(leftBucket.amount - rightBucket.amount) > allowed) {
      discrepancies.push({
        kind: "tax-entry-amount",
        scope: "tax",
        field: "tax",
        rate: leftBucket.rate,
        expected: leftBucket.amount,
        observed: rightBucket.amount,
        delta: rightBucket.amount - leftBucket.amount,
        tolerance: allowed,
        message: `Tax at rate ${leftBucket.rate} differs by ${rightBucket.amount - leftBucket.amount}`,
      });
    }
  }

  for (let index = 0; index < right.length; index += 1) {
    if (usedRight.has(index)) continue;
    const bucket = right[index];
    discrepancies.push({
      kind: "tax-entry-unexpected",
      scope: "tax",
      field: "tax",
      rate: bucket.rate,
      observed: bucket.amount,
      message: `Unexpected OCR tax entry at rate ${bucket.rate}`,
    });
  }

  return discrepancies;
}

function sortDiscrepancies(discrepancies: Discrepancy[]): void {
  const scopeRank: Record<Discrepancy["scope"], number> = {
    line: 0,
    tax: 1,
    summary: 2,
    document: 3,
  };
  const lineFieldRank: Record<string, number> = {
    line: 0,
    amount: 0,
    unitAmount: 1,
    quantity: 2,
    taxRate: 3,
    taxAmount: 4,
    discount: 5,
    discountRate: 6,
    sku: 7,
  };
  const summaryFieldRank: Record<string, number> = {
    subtotal: 0,
    discount: 1,
    tax: 2,
    total: 3,
  };
  discrepancies.sort((a, b) => {
    const scope = scopeRank[a.scope] - scopeRank[b.scope];
    if (scope !== 0) return scope;
    const expectedIndex =
      (a.expectedIndex ?? Number.MAX_SAFE_INTEGER) -
      (b.expectedIndex ?? Number.MAX_SAFE_INTEGER);
    if (expectedIndex !== 0) return expectedIndex;
    const observedIndex =
      (a.observedIndex ?? Number.MAX_SAFE_INTEGER) -
      (b.observedIndex ?? Number.MAX_SAFE_INTEGER);
    if (observedIndex !== 0) return observedIndex;
    const rank = a.scope === "summary" ? summaryFieldRank : lineFieldRank;
    const field = (rank[a.field ?? ""] ?? 99) - (rank[b.field ?? ""] ?? 99);
    if (field !== 0) return field;
    return a.kind.localeCompare(b.kind);
  });
}

function runReconcile(
  expectedInput: InvoiceDocument | readonly InvoiceLine[],
  observedInput: InvoiceDocument | readonly InvoiceLine[],
  policyInput?: CurrencyPolicyInput,
  optionsInput: ReconcileOptions = {},
): ReconciliationResult {
  const expectedRaw = asDocument(expectedInput);
  const observedRaw = asDocument(observedInput);
  const options = { ...DEFAULT_OPTIONS, ...optionsInput };
  const selectedPolicy =
    policyInput ??
    expectedRaw.policy ??
    observedRaw.policy ??
    expectedRaw.currency ??
    observedRaw.currency ??
    DEFAULT_CURRENCY_POLICY;
  const policy = createCurrencyPolicy(selectedPolicy);
  const expected = normalizeDocument(expectedRaw, policy, options);
  const observed = normalizeDocument(observedRaw, policy, options);
  const lineCount = Math.max(expected.lines.length, observed.lines.length);

  const lineResult = matchDocumentLines(expected, observed, policy, options);
  const summaryResult = compareSummaries(
    expected,
    observed,
    policy,
    lineCount,
  );
  const discrepancies = [...lineResult.discrepancies, ...summaryResult.discrepancies];

  if (options.checkSummaryArithmetic) {
    discrepancies.push(
      ...checkArithmetic(
        "expected",
        expected,
        policy,
        lineCount,
        summaryResult.comparedFields,
      ),
      ...checkArithmetic(
        "observed",
        observed,
        policy,
        lineCount,
        summaryResult.comparedFields,
      ),
    );
  }

  if (options.compareTaxEntries) {
    discrepancies.push(
      ...compareTaxEntries(expected, observed, policy, lineCount),
    );
  }

  sortDiscrepancies(discrepancies);
  const summary: SummaryReconciliation = {
    expected: expected.summary,
    observed: observed.summary,
    derived: {
      expected: expected.derived,
      observed: observed.derived,
    },
  };
  const ok = discrepancies.length === 0;
  return {
    ok,
    reconciled: ok,
    discrepancies,
    issues: discrepancies,
    inconsistencies: discrepancies,
    minimalInconsistencySet: discrepancies,
    matches: lineResult.matches,
    unmatchedExpected: lineResult.unmatchedExpected.map((line) => line.raw),
    unmatchedObserved: lineResult.unmatchedObserved.map((line) => line.raw),
    unmatchedActual: lineResult.unmatchedObserved.map((line) => line.raw),
    summary,
  };
}

/**
 * Reconcile expected invoice data with OCR-observed data.
 *
 * Monetary values are integer minor units. Same-name lines are assigned with
 * an exact minimum-cost matching that prioritizes consistent fields, then
 * positional proximity, then amount proximity.
 */
export function reconcile(
  expected: InvoiceDocument | readonly InvoiceLine[],
  observed: InvoiceDocument | readonly InvoiceLine[],
  policy?: CurrencyPolicyInput,
  options?: ReconcileOptions,
): ReconciliationResult;
export function reconcile(
  request: ReconcileRequest,
): ReconciliationResult;
export function reconcile(
  first: InvoiceDocument | readonly InvoiceLine[] | ReconcileRequest,
  second?: InvoiceDocument | readonly InvoiceLine[],
  policy?: CurrencyPolicyInput,
  options?: ReconcileOptions,
): ReconciliationResult {
  if (isRequest(first)) {
    const observed = first.observed ?? first.actual;
    if (!observed) {
      throw new TypeError("Reconcile request needs observed or actual data");
    }
    return runReconcile(
      first.expected,
      observed,
      first.policy ?? first.currency,
      first.options,
    );
  }
  if (!second) {
    throw new TypeError("reconcile needs expected and observed inputs");
  }
  if (!isDocument(second) && !Array.isArray(second)) {
    throw new TypeError("Observed input must be a document or line array");
  }
  return runReconcile(first, second, policy, options);
}

export const reconcileInvoice = reconcile;
export const reconcileInvoices = reconcile;
export const reconcileDocuments = reconcile;

export function reconcileLineItems(
  expected: readonly InvoiceLine[],
  observed: readonly InvoiceLine[],
  policy?: CurrencyPolicyInput,
  options?: ReconcileOptions,
): ReconciliationResult {
  return reconcile({ lines: expected }, { lines: observed }, policy, options);
}

export const reconcileLines = reconcileLineItems;
export const reconcileInvoiceLines = reconcileLineItems;

export function matchLineItems(
  expected: readonly InvoiceLine[],
  observed: readonly InvoiceLine[],
  policy?: CurrencyPolicyInput,
  options?: ReconcileOptions,
): LineMatch[] {
  return reconcileLineItems(expected, observed, policy, options).matches;
}

export const matchLines = matchLineItems;

export function findMinimalInconsistencySet(
  expected: InvoiceDocument | readonly InvoiceLine[],
  observed: InvoiceDocument | readonly InvoiceLine[],
  policy?: CurrencyPolicyInput,
  options?: ReconcileOptions,
): Discrepancy[] {
  return reconcile(expected, observed, policy, options).minimalInconsistencySet;
}

export const minimalInconsistencySet = findMinimalInconsistencySet;
export const findMinimumInconsistencySet = findMinimalInconsistencySet;

/** Derive line-based totals without comparing two documents. */
export function deriveSummary(
  document: InvoiceDocument | readonly InvoiceLine[],
  policyInput?: CurrencyPolicyInput,
  options: ReconcileOptions = {},
): InvoiceTotals {
  const raw = asDocument(document);
  const merged = { ...DEFAULT_OPTIONS, ...options };
  const policy = createCurrencyPolicy(
    policyInput ??
      raw.policy ??
      raw.currency ??
      DEFAULT_CURRENCY_POLICY,
  );
  const normalized = normalizeDocument(raw, policy, merged);
  return {
    subtotal: normalized.derived.subtotal,
    discount: normalized.derived.discount,
    tax: normalized.derived.tax,
    total: normalized.derived.total,
  };
}
