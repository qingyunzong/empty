import type {
  CurrencyPolicy,
  DerivedTotals,
  InvoiceDocument,
  InvoiceLine,
  InvoiceTotals,
  LineDiscount,
  MinorUnits,
  RateInput,
  TaxEntry,
} from "./types.js";

export interface NormalizedLine {
  raw: InvoiceLine;
  index: number;
  name: string;
  position: number;
  amount: MinorUnits;
  quantity: number | null;
  unitAmount: MinorUnits | null;
  taxRate: number | null;
  taxAmount: MinorUnits | null;
  discountAmount: MinorUnits | null;
  discountRate: number | null;
  sku: string | null;
}

export interface NormalizedTaxEntry {
  raw: TaxEntry;
  index: number;
  rate: number;
  amount: MinorUnits;
  taxable: MinorUnits | null;
}

export interface NormalizedDocument {
  raw: InvoiceDocument;
  currency: string;
  lines: NormalizedLine[];
  summary: InvoiceTotals;
  taxes: NormalizedTaxEntry[];
  derived: DerivedTotals;
}

const AMOUNT_KEYS = [
  "amount",
  "amountMinor",
  "netAmount",
  "lineAmount",
  "lineTotal",
  "total",
  "totalAmount",
  "grossAmount",
] as const;

const NAME_KEYS = ["name", "description", "label", "text"] as const;

function firstDefined<T>(...values: Array<T | undefined>): T | undefined {
  for (const value of values) {
    if (value !== undefined) return value;
  }
  return undefined;
}

function finiteNumber(value: unknown, label: string): number {
  if (typeof value === "string" && value.trim()) {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new TypeError(`${label} must be a finite number`);
  }
  return value;
}

function money(value: unknown, label: string, requireInteger: boolean): MinorUnits {
  const number = finiteNumber(value, label);
  if (requireInteger && !Number.isSafeInteger(number)) {
    throw new RangeError(`${label} must be an integer number of minor units`);
  }
  if (!Number.isSafeInteger(number)) {
    throw new RangeError(`${label} exceeds the safe integer range`);
  }
  return number;
}

export function normalizeRate(
  value: RateInput | undefined,
  basisPoints?: number,
): number | null {
  if (basisPoints !== undefined) {
    return finiteNumber(basisPoints, "basisPoints") / 10_000;
  }
  if (value === undefined) return null;

  if (typeof value === "string") {
    const text = value.trim();
    if (!text) return null;
    const percent = text.endsWith("%");
    const parsed = Number(percent ? text.slice(0, -1).trim() : text);
    if (!Number.isFinite(parsed)) {
      throw new TypeError(`Invalid rate: ${value}`);
    }
    return percent || parsed > 1 ? parsed / 100 : parsed;
  }

  const number = finiteNumber(value, "rate");
  return number > 1 ? number / 100 : number;
}

export function normalizeLineName(
  line: InvoiceLine,
  caseSensitive = false,
): string {
  let value: string | undefined;
  for (const key of NAME_KEYS) {
    const candidate = line[key];
    if (typeof candidate === "string" && candidate.trim()) {
      value = candidate;
      break;
    }
  }
  value ??= line.sku ?? line.id ?? "";
  const normalized = value
    .normalize("NFKC")
    .trim()
    .replace(/\s+/g, " ");
  return caseSensitive ? normalized : normalized.toLowerCase();
}

function resolveAmount(line: InvoiceLine, requireInteger: boolean): MinorUnits {
  for (const key of AMOUNT_KEYS) {
    const candidate = line[key];
    if (candidate !== undefined) {
      return money(candidate, `line ${key}`, requireInteger);
    }
  }
  throw new TypeError("Each invoice line needs an amount in minor units");
}

function resolveDiscount(
  line: InvoiceLine,
  requireInteger: boolean,
): { amount: MinorUnits | null; rate: number | null } {
  let amount: MinorUnits | null = null;
  let rate: number | null = null;

  if (typeof line.discount === "number" || typeof line.discount === "string") {
    const text = String(line.discount).trim();
    if (typeof line.discount === "string" && text.endsWith("%")) {
      rate = normalizeRate(line.discount);
    } else {
      amount = money(line.discount, "line discount", requireInteger);
    }
  } else if (line.discount && typeof line.discount === "object") {
    const discount = line.discount as LineDiscount;
    if (discount.amount !== undefined) {
      amount = money(discount.amount, "line discount", requireInteger);
    }
    rate = normalizeRate(discount.rate, discount.rateBps);
  }

  if (line.discountAmount !== undefined) {
    amount = money(line.discountAmount, "line discountAmount", requireInteger);
  }
  if (line.discountRate !== undefined || line.discountRateBps !== undefined) {
    rate = normalizeRate(line.discountRate, line.discountRateBps);
  }

  return { amount, rate };
}

function resolveTaxAmount(
  line: InvoiceLine,
  requireInteger: boolean,
): MinorUnits | null {
  const value = firstDefined(line.taxAmount, line.tax);
  return value === undefined
    ? null
    : money(value, "line tax amount", requireInteger);
}

function resolvePosition(line: InvoiceLine, index: number): number {
  const value = firstDefined(line.position, line.lineNumber);
  if (value === undefined) return index;
  const number = finiteNumber(value, "line position");
  if (!Number.isInteger(number)) {
    throw new TypeError("line position must be an integer");
  }
  return number;
}

export function normalizeDocument(
  document: InvoiceDocument,
  policy: CurrencyPolicy,
  options: { requireIntegerAmounts: boolean; caseSensitiveNames: boolean },
): NormalizedDocument {
  const sourceLines = document?.lines ?? document?.lineItems ?? document?.items;
  if (!Array.isArray(sourceLines)) {
    throw new TypeError("Invoice document must contain a lines, lineItems or items array");
  }

  const lines = sourceLines.map((line, index) => {
    const discount = resolveDiscount(line, options.requireIntegerAmounts);
    return {
      raw: line,
      index,
      name: normalizeLineName(line, options.caseSensitiveNames),
      position: resolvePosition(line, index),
      amount: resolveAmount(line, options.requireIntegerAmounts),
      quantity:
        line.quantity === undefined
          ? null
          : finiteNumber(line.quantity, "line quantity"),
      unitAmount:
        line.unitAmount !== undefined
          ? money(line.unitAmount, "line unitAmount", options.requireIntegerAmounts)
          : line.unitPrice !== undefined
            ? money(line.unitPrice, "line unitPrice", options.requireIntegerAmounts)
            : line.unitPriceMinor !== undefined
              ? money(line.unitPriceMinor, "line unitPriceMinor", options.requireIntegerAmounts)
            : null,
      taxRate: normalizeRate(line.taxRate, line.taxRateBps),
      taxAmount: resolveTaxAmount(line, options.requireIntegerAmounts),
      discountAmount: discount.amount,
      discountRate: discount.rate,
      sku:
        typeof line.sku === "string" && line.sku.trim()
          ? line.sku.trim()
          : null,
    } satisfies NormalizedLine;
  });

  const summary = resolveSummary(document, options.requireIntegerAmounts);
  const taxes = normalizeTaxes(document.taxes, options.requireIntegerAmounts);
  return {
    raw: document,
    currency: document.currency?.toUpperCase() ?? policy.code,
    lines,
    summary,
    taxes,
    derived: deriveTotals(lines),
  };
}

export function resolveSummary(
  document: InvoiceDocument,
  requireInteger: boolean,
): InvoiceTotals {
  const nested = document.summary ?? document.totals ?? {};
  const pick = (
    keys: Array<keyof InvoiceTotals>,
  ): MinorUnits | undefined => {
    const value = firstDefined(
      ...keys.map((key) => document[key]),
      ...keys.map((key) => nested[key]),
    );
    return value === undefined
      ? undefined
      : money(value, `summary ${keys[0]}`, requireInteger);
  };
  return {
    subtotal: pick(["subtotal", "subTotal"]),
    discount: pick(["discount", "discountTotal"]),
    tax: pick(["tax", "taxTotal"]),
    total: pick(["total", "grandTotal"]),
  };
}

function normalizeTaxes(
  taxes: readonly TaxEntry[] | undefined,
  requireInteger: boolean,
): NormalizedTaxEntry[] {
  if (!taxes) return [];
  return taxes.map((entry, index) => {
    const rate = normalizeRate(
      entry.rate ?? entry.taxRate,
      entry.rateBps ?? entry.taxRateBps,
    );
    if (rate === null) {
      throw new TypeError(`Tax entry ${index} needs a rate`);
    }
    const amount = entry.amount ?? entry.taxAmount;
    if (amount === undefined) {
      throw new TypeError(`Tax entry ${index} needs an amount`);
    }
    return {
      raw: entry,
      index,
      rate,
      amount: money(amount, "tax entry amount", requireInteger),
      taxable:
        entry.taxable === undefined
          ? null
          : money(entry.taxable, "tax entry taxable", requireInteger),
    };
  });
}

function deriveTotals(lines: NormalizedLine[]): DerivedTotals {
  let subtotal = 0;
  let discount = 0;
  let tax = 0;
  let hasTax = false;
  for (const line of lines) {
    subtotal += line.amount;
    discount += line.discountAmount ?? 0;
    if (line.taxAmount !== null) {
      tax += line.taxAmount;
      hasTax = true;
    }
  }
  return {
    subtotal,
    discount,
    tax: hasTax ? tax : undefined,
    total: hasTax ? subtotal - discount + tax : undefined,
  };
}
