import type {
  CurrencyPolicy,
  CurrencyPolicyInput,
  CurrencyPolicyOverrides,
  ToleranceContext,
  ToleranceRule,
} from "./types.js";

const ZERO_POLICY = {
  lineTolerance: 0,
  unitAmountTolerance: 0,
  quantityTolerance: 0,
  taxRateTolerance: 0,
  taxTolerance: 0,
  discountTolerance: 0,
  discountRateTolerance: 0,
  subtotalTolerance: 0,
  totalTolerance: 0,
} as const;

function policy(
  code: string,
  minorUnitDigits: number,
  overrides: Partial<Record<keyof typeof ZERO_POLICY, ToleranceRule>> = {},
): CurrencyPolicy {
  return {
    code,
    minorUnitDigits,
    ...ZERO_POLICY,
    ...overrides,
  };
}

/**
 * ISO-4217-aligned defaults. Line amounts stay strict; the one-minor-unit
 * allowance is applied where per-line or per-rate rounding normally accumulates.
 */
export const CURRENCY_POLICIES: Readonly<Record<string, CurrencyPolicy>> =
  Object.freeze({
    CNY: policy("CNY", 2, {
      lineTolerance: 0,
      taxRateTolerance: 0.00005,
      taxTolerance: 1,
      discountTolerance: 1,
      subtotalTolerance: 1,
      totalTolerance: 1,
    }),
    USD: policy("USD", 2, {
      lineTolerance: 0,
      taxRateTolerance: 0.00005,
      taxTolerance: 1,
      discountTolerance: 1,
      subtotalTolerance: 1,
      totalTolerance: 1,
    }),
    EUR: policy("EUR", 2, {
      lineTolerance: 0,
      taxRateTolerance: 0.00005,
      taxTolerance: 1,
      discountTolerance: 1,
      subtotalTolerance: 1,
      totalTolerance: 1,
    }),
    GBP: policy("GBP", 2, {
      lineTolerance: 0,
      taxRateTolerance: 0.00005,
      taxTolerance: 1,
      discountTolerance: 1,
      subtotalTolerance: 1,
      totalTolerance: 1,
    }),
    JPY: policy("JPY", 0, {
      taxRateTolerance: 0.00005,
      taxTolerance: 1,
      discountTolerance: 1,
      subtotalTolerance: 1,
      totalTolerance: 1,
    }),
    KRW: policy("KRW", 0, {
      taxRateTolerance: 0.00005,
      taxTolerance: 1,
      discountTolerance: 1,
      subtotalTolerance: 1,
      totalTolerance: 1,
    }),
    KWD: policy("KWD", 3, {
      taxRateTolerance: 0.00005,
      taxTolerance: 1,
      discountTolerance: 1,
      subtotalTolerance: 1,
      totalTolerance: 1,
    }),
    BHD: policy("BHD", 3, {
      taxRateTolerance: 0.00005,
      taxTolerance: 1,
      discountTolerance: 1,
      subtotalTolerance: 1,
      totalTolerance: 1,
    }),
  });

export const builtInCurrencyPolicies = CURRENCY_POLICIES;
/**
 * Used when the caller does not provide a policy. It is deliberately strict:
 * rounding allowances should be an explicit choice, not an invisible default.
 */
export const DEFAULT_CURRENCY_POLICY = policy("CNY", 2);

function isPolicyObject(value: unknown): value is CurrencyPolicyOverrides {
  return typeof value === "object" && value !== null;
}

export function createCurrencyPolicy(
  input: CurrencyPolicyInput = DEFAULT_CURRENCY_POLICY,
): CurrencyPolicy {
  if (typeof input === "string") {
    const key = input.trim().toUpperCase();
    const builtIn = CURRENCY_POLICIES[key];
    if (builtIn) return { ...builtIn };
    if (!/^[A-Z]{3}$/.test(key)) {
      throw new RangeError(`Invalid currency code: ${input}`);
    }
    return policy(key, 2);
  }

  if (!isPolicyObject(input)) {
    throw new TypeError("Currency policy must be a code or an object");
  }

  const code =
    typeof input.code === "string" && input.code.trim()
      ? input.code.trim().toUpperCase()
      : "CUSTOM";
  const base = CURRENCY_POLICIES[code] ?? policy(code, 2);
  const {
    tolerance,
    roundingTolerance,
    roundingError,
    roundingUnit,
    allowedRounding,
    rateTolerance,
  } = input;
  const commonMoneyTolerance =
    tolerance ??
    roundingTolerance ??
    roundingError ??
    roundingUnit ??
    allowedRounding;
  const codeInput = input.code ?? input.currency;

  const merged: CurrencyPolicy = {
    ...base,
    ...Object.fromEntries(
      Object.entries(input).filter(([, value]) => value !== undefined),
    ),
    code: typeof codeInput === "string" && codeInput.trim()
      ? codeInput.trim().toUpperCase()
      : code,
    minorUnitDigits:
      input.minorUnitDigits ??
      input.decimalPlaces ??
      input.minorUnits ??
      input.precision ??
      base.minorUnitDigits,
  } as CurrencyPolicy;

  if (commonMoneyTolerance !== undefined) {
    merged.lineTolerance = commonMoneyTolerance;
    merged.unitAmountTolerance = commonMoneyTolerance;
    merged.taxTolerance = commonMoneyTolerance;
    merged.discountTolerance = commonMoneyTolerance;
    merged.subtotalTolerance = commonMoneyTolerance;
    merged.totalTolerance = commonMoneyTolerance;
  }
  if (rateTolerance !== undefined) {
    merged.taxRateTolerance = rateTolerance;
    merged.discountRateTolerance = rateTolerance;
  }

  // Aliases kept off the public shape but useful in permissive JS callers.
  const loose = input as CurrencyPolicyOverrides & {
    line?: ToleranceRule;
    tax?: ToleranceRule;
    discount?: ToleranceRule;
    subtotal?: ToleranceRule;
    total?: ToleranceRule;
    rates?: ToleranceRule;
  };
  merged.lineTolerance = loose.lineTolerance ?? loose.line ?? merged.lineTolerance;
  merged.taxTolerance = loose.taxTolerance ?? loose.tax ?? merged.taxTolerance;
  merged.discountTolerance =
    loose.discountTolerance ?? loose.discount ?? merged.discountTolerance;
  merged.subtotalTolerance =
    loose.subtotalTolerance ?? loose.subtotal ?? merged.subtotalTolerance;
  merged.totalTolerance =
    loose.totalTolerance ?? loose.total ?? merged.totalTolerance;
  merged.taxRateTolerance =
    loose.taxRateTolerance ?? loose.rates ?? merged.taxRateTolerance;
  merged.discountRateTolerance =
    loose.discountRateTolerance ?? loose.rates ?? merged.discountRateTolerance;

  validatePolicy(merged);
  return merged;
}

export const defineCurrencyPolicy = createCurrencyPolicy;

export function validatePolicy(value: CurrencyPolicy): void {
  if (!Number.isInteger(value.minorUnitDigits) || value.minorUnitDigits < 0 || value.minorUnitDigits > 6) {
    throw new RangeError("minorUnitDigits must be an integer from 0 to 6");
  }
  const rules: Array<[string, ToleranceRule]> = [
    ["lineTolerance", value.lineTolerance],
    ["unitAmountTolerance", value.unitAmountTolerance],
    ["quantityTolerance", value.quantityTolerance],
    ["taxRateTolerance", value.taxRateTolerance],
    ["taxTolerance", value.taxTolerance],
    ["discountTolerance", value.discountTolerance],
    ["discountRateTolerance", value.discountRateTolerance],
    ["subtotalTolerance", value.subtotalTolerance],
    ["totalTolerance", value.totalTolerance],
  ];
  for (const [name, rule] of rules) {
    if (typeof rule === "number" && (!Number.isFinite(rule) || rule < 0)) {
      throw new RangeError(`${name} must be a finite, non-negative number`);
    }
    if (typeof rule !== "number" && typeof rule !== "function") {
      throw new TypeError(`${name} must be a number or a function`);
    }
  }
}

export function resolveTolerance(
  rule: ToleranceRule,
  context: ToleranceContext,
): number {
  const raw = typeof rule === "function" ? rule(context) : rule;
  if (!Number.isFinite(raw) || raw < 0) {
    throw new RangeError(
      `Tolerance for ${context.scope} must be finite and non-negative`,
    );
  }
  return raw;
}
