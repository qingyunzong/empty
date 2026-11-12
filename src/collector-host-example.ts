// Real collector-host usage example.
//
// A captured document store row yields raw 16-byte BID decimal128 fields.
// The host must align every value to a target quantum without ever converting
// through a JavaScript Number. This script shows the full flow and checks each
// result against the independent numerator/denominator reference model.

import {
  Create,
  EXP_MAX,
  EXP_MIN,
  MAX_COEFF,
  NumericCompare,
  Quantize,
  fromBytes,
  type Bid128Field,
  type RoundingMode,
} from "./bid128.ts";
import { referenceCompare, referenceQuantize } from "./reference.ts";

const TARGET_EXPONENT = -2;
const MODE: RoundingMode = "nearestEven";

function describe(field: Bid128Field): string {
  const view = field.parse();
  if (view.kind === "nan") {
    return "NaN";
  }
  if (view.kind === "infinity") {
    return `${view.sign === 1 ? "-" : "+"}Infinity`;
  }
  const nonCanonical = view.nonCanonical ? " (non-canonical source)" : "";
  return `(-1)^${view.sign} * ${view.coefficient} * 10^${view.exponent}${nonCanonical}`;
}

// Simulated captured 16-byte little-endian fields from a document row.
const capturedRows: Array<{ column: string; field: Bid128Field }> = [
  { column: "amount_34_digits", field: Create(0, MAX_COEFF, 0) },
  { column: "negative_zero", field: Create(1, 0n, -7) },
  { column: "cents_with_tail", field: Create(0, 1234567n, -4) },
  { column: "smallest_subnormal_like", field: Create(1, 1n, EXP_MIN) },
  { column: "largest_exponent", field: Create(0, 42n, EXP_MAX) },
];

let failures = 0;

for (const row of capturedRows) {
  const source = fromBytes(row.field.rawBytes()); // immutable snapshot
  const result = Quantize(source, TARGET_EXPONENT, MODE);

  if (result.status === "notFinite") {
    console.log(`${row.column}: special value, original 16 bytes retained`);
    continue;
  }
  if (result.status === "invalidQuantize") {
    console.log(`${row.column}: rejected, coefficient would exceed 34 digits at q=${TARGET_EXPONENT}`);
    continue;
  }

  const reference = referenceQuantize(source, TARGET_EXPONENT, MODE);
  if (reference.status !== "ok") {
    failures += 1;
    console.error(`${row.column}: reference status mismatch ${reference.status}`);
    continue;
  }

  const matchesReference =
    result.sign === reference.sign &&
    result.coefficient === reference.coefficient &&
    result.exponent === reference.exponent &&
    result.rounded === reference.rounded &&
    result.inexact === reference.inexact;

  if (!matchesReference) {
    failures += 1;
    console.error(`${row.column}: mismatch against rational reference`);
  }

  console.log(
    `${row.column}: ${describe(source)} -> C=${result.coefficient}, e=${result.exponent} ` +
      `[rounded=${result.rounded}, inexact=${result.inexact}, ` +
      `sourceNonCanonical=${result.sourceNonCanonical}]`,
  );
}

// Exact-decimal ordering across differently quantized but equal values.
const left = Create(0, 123n, 2);
const right = Create(0, 12300n, 0);
const ordering = NumericCompare(left, right);
const referenceOrdering = referenceCompare(left, right);
if (ordering !== "equal" || referenceOrdering !== "equal") {
  failures += 1;
}
console.log(`quantum-independent compare: ${ordering} (reference ${referenceOrdering})`);

if (failures > 0) {
  console.error(`collector host example failed with ${failures} mismatch(es)`);
  process.exitCode = 1;
} else {
  console.log("collector host example: all fields agree with the rational reference");
}
