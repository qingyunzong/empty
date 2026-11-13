export type MinorUnits = number;

/**
 * Tax and discount rates are decimal fractions (`0.13` = 13%).
 * Strings ending in `%` and numeric values greater than 1 are accepted as
 * percentages for compatibility with OCR output.
 */
export type RateInput = number | string;

export type ToleranceScope =
  | "line-amount"
  | "unit-amount"
  | "quantity"
  | "tax-rate"
  | "tax-amount"
  | "discount-amount"
  | "discount-rate"
  | "subtotal"
  | "tax"
  | "discount"
  | "total"
  | "tax-entry-amount";

export interface ToleranceContext {
  currency: string;
  scope: ToleranceScope;
  expected: number;
  observed: number;
  lineCount: number;
}

/**
 * An absolute allowance in minor currency units, or a function that derives
 * one (for example a policy that grows the allowance with line count).
 */
export type ToleranceRule = number | ((context: ToleranceContext) => number);

export interface CurrencyPolicy {
  code: string;
  minorUnitDigits: number;
  lineTolerance: ToleranceRule;
  unitAmountTolerance: ToleranceRule;
  quantityTolerance: ToleranceRule;
  taxRateTolerance: ToleranceRule;
  taxTolerance: ToleranceRule;
  discountTolerance: ToleranceRule;
  discountRateTolerance: ToleranceRule;
  subtotalTolerance: ToleranceRule;
  totalTolerance: ToleranceRule;
}

export interface CurrencyPolicyOverrides {
  code?: string;
  currency?: string;
  minorUnitDigits?: number;
  decimalPlaces?: number;
  /** Alias for the number of digits in one minor unit. */
  minorUnits?: number;
  precision?: number;

  lineTolerance?: ToleranceRule;
  unitAmountTolerance?: ToleranceRule;
  quantityTolerance?: ToleranceRule;
  taxRateTolerance?: ToleranceRule;
  taxTolerance?: ToleranceRule;
  discountTolerance?: ToleranceRule;
  discountRateTolerance?: ToleranceRule;
  subtotalTolerance?: ToleranceRule;
  totalTolerance?: ToleranceRule;

  /** Convenience: applies the same absolute allowance to every money scope. */
  tolerance?: ToleranceRule;
  /** Alias for {@link tolerance}. */
  roundingTolerance?: ToleranceRule;
  /** Alias for {@link tolerance}. */
  roundingError?: ToleranceRule;
  /** Alias for {@link tolerance}. */
  roundingUnit?: ToleranceRule;
  /** Alias for {@link tolerance}. */
  allowedRounding?: ToleranceRule;
  /** Convenience: applies the same allowance to tax and discount rates. */
  rateTolerance?: ToleranceRule;
}

export type CurrencyPolicyInput =
  | string
  | CurrencyPolicy
  | CurrencyPolicyOverrides;

export interface LineDiscount {
  amount?: MinorUnits;
  rate?: number;
  rateBps?: number;
}

export interface InvoiceLine {
  id?: string;
  sku?: string;
  name?: string;
  description?: string;
  label?: string;
  text?: string;
  position?: number;
  lineNumber?: number;

  quantity?: number;
  unitPrice?: MinorUnits;
  unitPriceMinor?: MinorUnits;
  unitAmount?: MinorUnits;

  /** Net amount before tax and before document-level discount, in minor units. */
  amount?: MinorUnits;
  amountMinor?: MinorUnits;
  netAmount?: MinorUnits;
  lineAmount?: MinorUnits;
  lineTotal?: MinorUnits;
  total?: MinorUnits;
  totalAmount?: MinorUnits;
  grossAmount?: MinorUnits;

  taxRate?: RateInput;
  taxRateBps?: number;
  taxAmount?: MinorUnits;
  tax?: MinorUnits;

  discount?: MinorUnits | string | LineDiscount;
  discountAmount?: MinorUnits;
  discountRate?: number;
  discountRateBps?: number;
}

export interface TaxEntry {
  rate?: RateInput;
  taxRate?: RateInput;
  rateBps?: number;
  taxRateBps?: number;
  amount?: MinorUnits;
  taxAmount?: MinorUnits;
  taxable?: MinorUnits;
}

export interface InvoiceTotals {
  subtotal?: MinorUnits;
  subTotal?: MinorUnits;
  discount?: MinorUnits;
  discountTotal?: MinorUnits;
  tax?: MinorUnits;
  taxTotal?: MinorUnits;
  total?: MinorUnits;
  grandTotal?: MinorUnits;
}

export interface InvoiceDocument extends InvoiceTotals {
  currency?: string;
  lines?: readonly InvoiceLine[];
  lineItems?: readonly InvoiceLine[];
  items?: readonly InvoiceLine[];
  taxes?: readonly TaxEntry[];
  summary?: InvoiceTotals;
  totals?: InvoiceTotals;
  policy?: CurrencyPolicyInput;
}

export interface ReconcileOptions {
  /** Check each document's declared totals against its own lines. Default `true`. */
  checkSummaryArithmetic?: boolean;
  /** Compare `taxes` arrays rate-by-rate. Default `true`. */
  compareTaxEntries?: boolean;
  /** Compare quantity when both sides provide it. Default `true`. */
  compareQuantities?: boolean;
  /** Compare unit price/amount when both sides provide it. Default `true`. */
  compareUnitAmounts?: boolean;
  /** Compare SKU when both sides provide it. Default `true`. */
  compareSkus?: boolean;
  /** Do not fold case or collapse whitespace in line names. Default `false`. */
  caseSensitiveNames?: boolean;
  /** Reject non-integer monetary amounts. Default `true`. */
  requireIntegerAmounts?: boolean;
}

export interface ReconcileRequest {
  expected: InvoiceDocument | readonly InvoiceLine[];
  observed?: InvoiceDocument | readonly InvoiceLine[];
  /** Alias for `observed`. */
  actual?: InvoiceDocument | readonly InvoiceLine[];
  currency?: string;
  policy?: CurrencyPolicyInput;
  options?: ReconcileOptions;
}

export interface LineMatch {
  expected: InvoiceLine;
  observed: InvoiceLine;
  /** Alias for `observed`. */
  actual: InvoiceLine;
  expectedIndex: number;
  observedIndex: number;
  name: string;
  positionDistance: number;
  amountDistance: MinorUnits;
  consistent: boolean;
}

export type DiscrepancyKind =
  | "line-missing"
  | "line-unexpected"
  | "line-amount"
  | "line-unit-amount"
  | "line-quantity"
  | "line-tax-rate"
  | "line-tax-amount"
  | "line-discount"
  | "line-discount-rate"
  | "line-sku"
  | "summary-subtotal"
  | "summary-discount"
  | "summary-tax"
  | "summary-total"
  | "summary-arithmetic"
  | "tax-entry-missing"
  | "tax-entry-unexpected"
  | "tax-entry-rate"
  | "tax-entry-amount";

export interface Discrepancy {
  kind: DiscrepancyKind;
  scope: "line" | "summary" | "tax" | "document";
  field?: string;
  message: string;
  name?: string;
  expectedIndex?: number;
  observedIndex?: number;
  expectedId?: string;
  observedId?: string;
  position?: number;
  expected?: number | string;
  observed?: number | string;
  delta?: number;
  tolerance?: number;
  expectedLine?: InvoiceLine;
  observedLine?: InvoiceLine;
  rate?: number;
  side?: "expected" | "observed";
}

export interface DerivedTotals {
  subtotal: MinorUnits;
  discount: MinorUnits;
  tax?: MinorUnits;
  total?: MinorUnits;
}

export interface SummaryReconciliation {
  expected: InvoiceTotals;
  observed: InvoiceTotals;
  derived: {
    expected: DerivedTotals;
    observed: DerivedTotals;
  };
}

export interface ReconciliationResult {
  ok: boolean;
  /** Alias for `ok`. */
  reconciled: boolean;
  discrepancies: Discrepancy[];
  /** Alias for `discrepancies`. */
  issues: Discrepancy[];
  /** Alias for `discrepancies`. */
  inconsistencies: Discrepancy[];
  /**
   * The discrepancies that form the minimum-cardinality explanation chosen by
   * the exact line assignment.
   */
  minimalInconsistencySet: Discrepancy[];
  matches: LineMatch[];
  unmatchedExpected: InvoiceLine[];
  unmatchedObserved: InvoiceLine[];
  /** Alias for `unmatchedObserved`. */
  unmatchedActual: InvoiceLine[];
  summary: SummaryReconciliation;
}
