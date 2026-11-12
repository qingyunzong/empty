import test from "node:test";
import assert from "node:assert/strict";

import {
  BYTES,
  Create,
  EXP_BIAS,
  EXP_MAX,
  EXP_MIN,
  MAX_COEFF,
  NumericCompare,
  Quantize,
  fromBytes,
  type FieldView,
  type RoundingMode,
  type Sign,
} from "./bid128.ts";
import { referenceCompare, referenceQuantize } from "./reference.ts";

const MODES: RoundingMode[] = [
  "towardZero",
  "towardPositive",
  "towardNegative",
  "nearestEven",
  "nearestAway",
];

const MASK64 = (1n << 64n) - 1n;
const SIGN_BIT = 1n << 63n;

function leBytes(u128: bigint): Uint8Array {
  const bytes = new Uint8Array(BYTES);
  let remaining = u128;
  for (let index = 0; index < BYTES; index += 1) {
    bytes[index] = Number(remaining & 0xffn);
    remaining >>= 8n;
  }
  return bytes;
}

function assemble(h: bigint, l: bigint): Uint8Array {
  return leBytes(((h & MASK64) << 64n) | (l & MASK64));
}

function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  return a.length === b.length && a.every((byte, index) => byte === b[index]);
}

test("Create uses the canonical ordinary layout and round trips 34-digit extrema", () => {
  const field = Create(0, MAX_COEFF, 0);
  const view = field.parse();
  assert.equal(view.kind, "finite");
  if (view.kind !== "finite") {
    return;
  }
  assert.equal(view.coefficient, MAX_COEFF);
  assert.equal(view.exponent, 0);
  assert.equal(view.sign, 0);
  assert.equal(view.nonCanonical, false);

  const u = field.rawBytes().reduceRight((acc, byte) => (acc << 8n) | BigInt(byte), 0n);
  const h = u >> 64n;
  const l = u & MASK64;
  assert.equal(h, BigInt(EXP_BIAS) * (1n << 49n) + (MAX_COEFF >> 64n));
  assert.equal(l, MAX_COEFF & MASK64);

  const extreme = Create(1, 1n, EXP_MIN);
  const extremeView = extreme.parse();
  assert.equal(extremeView.kind, "finite");
  if (extremeView.kind === "finite") {
    assert.equal(extremeView.sign, 1);
    assert.equal(extremeView.exponent, EXP_MIN);
  }
  assert.equal(Create(0, 1n, EXP_MAX).parse().kind, "finite");

  assert.throws(() => Create(0, MAX_COEFF + 1n, 0), /coefficient/);
  assert.throws(() => Create(0, -1n, 0), /coefficient/);
  assert.throws(() => Create(2 as Sign, 1n, 0), /sign/);
  assert.throws(() => Create(0, 1n, EXP_MIN - 1), /exponent/);
  assert.throws(() => Create(0, 1n, EXP_MAX + 1), /exponent/);
});

test("max coefficient plus one encodes as a non-canonical zero, never a huge number", () => {
  const oversized = 10n ** 34n;
  const h = (BigInt(EXP_BIAS) << 49n) | (oversized >> 64n);
  const l = oversized & MASK64;
  const field = fromBytes(assemble(h, l));
  const view = field.parse();
  assert.equal(view.kind, "finite");
  if (view.kind !== "finite") {
    return;
  }
  assert.equal(view.nonCanonical, true);
  assert.equal(view.coefficient, 0n);
  assert.equal(view.exponent, 0);

  const result = Quantize(field, 2, "nearestEven");
  assert.equal(result.status, "ok");
  if (result.status !== "ok") {
    return;
  }
  assert.equal(result.coefficient, 0n);
  assert.equal(result.sign, 0);
  assert.equal(result.exponent, 2);
  assert.equal(result.rounded, true);
  assert.equal(result.inexact, false);
  assert.equal(result.sourceNonCanonical, true);
});

test("steering branch (top bits 11) decodes zero and preserves every raw byte", () => {
  const exponent = -3;
  const h =
    SIGN_BIT |
    (3n << 61n) |
    (BigInt(exponent + EXP_BIAS) << 47n) |
    0x123456789abcn;
  const l = 0x0fedcba987654321n;
  const raw = assemble(h, l);

  assert.equal((h >> 61n) & 3n, 3n);
  assert.notEqual((h >> 58n) & 31n, 30n);
  assert.notEqual((h >> 58n) & 31n, 31n);

  const field = fromBytes(raw);
  const view = field.parse();
  assert.equal(view.kind, "finite");
  if (view.kind !== "finite") {
    return;
  }
  assert.deepEqual(
    {
      sign: view.sign,
      coefficient: view.coefficient,
      exponent: view.exponent,
      nonCanonical: view.nonCanonical,
    },
    { sign: 1, coefficient: 0n, exponent: -3, nonCanonical: true },
  );
  assert.ok(bytesEqual(field.rawBytes(), raw));

  const result = Quantize(field, 2, "towardZero");
  assert.equal(result.status, "ok");
  if (result.status !== "ok") {
    return;
  }
  assert.equal(result.sign, 1);
  assert.equal(result.coefficient, 0n);
  assert.equal(result.exponent, 2);
  assert.equal(result.rounded, true);
  assert.equal(result.inexact, false);
  assert.equal(result.sourceNonCanonical, true);
  assert.ok(bytesEqual(field.rawBytes(), raw));
  assert.ok(!bytesEqual(result.field.rawBytes(), raw));
});

test("negative zero keeps its sign and exponent through every rounding mode", () => {
  const negZero = Create(1, 0n, -7);
  for (const mode of MODES) {
    const result = Quantize(negZero, -5, mode);
    assert.equal(result.status, "ok");
    if (result.status !== "ok") {
      return;
    }
    assert.equal(result.sign, 1, mode);
    assert.equal(result.coefficient, 0n, mode);
    assert.equal(result.exponent, -5, mode);
    assert.equal(result.inexact, false, mode);
    const u = result.field
      .rawBytes()
      .reduceRight((acc, byte) => (acc << 8n) | BigInt(byte), 0n);
    assert.equal((u >> 127n) & 1n, 1n, mode);
  }
  assert.equal(NumericCompare(negZero, Create(0, 0n, 123)), "equal");
  assert.equal(NumericCompare(Create(0, 0n, 0), negZero), "equal");
});

test("halfway cases honor nearest-even parity and nearest-away for both signs", () => {
  const cases = [
    { c: 12345n, expectEven: 1234n, expectAway: 1235n },
    { c: 12355n, expectEven: 1236n, expectAway: 1236n },
    { c: 12346n, expectEven: 1235n, expectAway: 1235n },
    { c: 12344n, expectEven: 1234n, expectAway: 1234n },
  ];
  for (const sign of [0, 1] as Sign[]) {
    for (const item of cases) {
      const field = Create(sign, item.c, 0);
      const even = Quantize(field, 1, "nearestEven");
      const away = Quantize(field, 1, "nearestAway");
      assert.equal(even.status, "ok");
      assert.equal(away.status, "ok");
      if (even.status !== "ok" || away.status !== "ok") {
        return;
      }
      assert.equal(even.coefficient, item.expectEven);
      assert.equal(away.coefficient, item.expectAway);
      assert.equal(even.sign, sign);
      assert.equal(away.sign, sign);
      assert.equal(even.inexact, true);
      assert.equal(even.rounded, true);
    }
  }
});

test("directed rounding never flips sign and only bumps toward the matching infinity", () => {
  const field = Create(1, 12345n, 0);
  const towardZero = Quantize(field, 1, "towardZero");
  const towardPositive = Quantize(field, 1, "towardPositive");
  const towardNegative = Quantize(field, 1, "towardNegative");
  if (
    towardZero.status !== "ok" ||
    towardPositive.status !== "ok" ||
    towardNegative.status !== "ok"
  ) {
    assert.fail("directed rounding should succeed");
    return;
  }
  assert.deepEqual(
    [towardZero.coefficient, towardPositive.coefficient, towardNegative.coefficient],
    [1234n, 1234n, 1235n],
  );
  for (const result of [towardZero, towardPositive, towardNegative]) {
    assert.equal(result.sign, 1);
  }

  const positiveField = Create(0, 12345n, 0);
  const positiveUp = Quantize(positiveField, 1, "towardPositive");
  const positiveDown = Quantize(positiveField, 1, "towardNegative");
  if (positiveUp.status !== "ok" || positiveDown.status !== "ok") {
    assert.fail("directed rounding should succeed");
    return;
  }
  assert.equal(positiveUp.coefficient, 1235n);
  assert.equal(positiveDown.coefficient, 1234n);
});

test("exact trailing-zero removal reports rounded=true with inexact=false", () => {
  // 12300 * 10^-4 = 123 * 10^-2: exponent rises, two trailing zeros removed exactly.
  const field = Create(0, 12300n, -4);
  const result = Quantize(field, -2, "nearestEven");
  assert.equal(result.status, "ok");
  if (result.status !== "ok") {
    return;
  }
  assert.equal(result.coefficient, 123n);
  assert.equal(result.exponent, -2);
  assert.equal(result.rounded, true);
  assert.equal(result.inexact, false);
  assert.equal(NumericCompare(field, result.field), "equal");
});

test("a carry that would need 35 digits is invalidQuantize with no result bytes", () => {
  const field = Create(0, MAX_COEFF, 0);
  const result = Quantize(field, -1, "nearestEven");
  assert.equal(result.status, "invalidQuantize");
  assert.equal("field" in result, false);

  // A division-time bump to exactly 10^34 cannot be built with Create: its
  // 35-digit numerator is itself decoded as a non-canonical zero by this
  // contract. The same post-round guard is therefore verified arithmetically.
  const divisor = 10n;
  const quotient = MAX_COEFF; // odd, largest legal 34-digit coefficient
  const remainder = 5n; // exact half
  const twice = 2n * remainder;
  const evenBumps =
    twice > divisor || (twice === divisor && (quotient & 1n) === 1n);
  assert.equal(evenBumps, true);
  assert.equal(quotient + 1n > MAX_COEFF, true);

  const view = field.parse();
  assert.equal(view.kind, "finite");
  if (view.kind === "finite") {
    assert.equal(view.coefficient, MAX_COEFF);
  }
});

test("tiny nonzero values can round to a sign-preserving zero", () => {
  const tiny = Create(1, 1n, EXP_MIN);
  const towardZero = Quantize(tiny, EXP_MIN + 1, "towardZero");
  const towardPositive = Quantize(tiny, EXP_MIN + 1, "towardPositive");
  const towardNegative = Quantize(tiny, EXP_MIN + 1, "towardNegative");
  if (
    towardZero.status !== "ok" ||
    towardPositive.status !== "ok" ||
    towardNegative.status !== "ok"
  ) {
    assert.fail("tiny rounding should succeed");
    return;
  }
  assert.deepEqual(
    {
      zero: [towardZero.coefficient, towardZero.sign, towardZero.inexact],
      up: [towardPositive.coefficient, towardPositive.sign],
      down: [towardNegative.coefficient, towardNegative.sign],
    },
    {
      zero: [0n, 1, true],
      up: [0n, 1],
      down: [1n, 1],
    },
  );
  assert.throws(() => Quantize(tiny, EXP_MIN - 1, "towardZero"), /q must/);
  assert.throws(() => Quantize(tiny, EXP_MAX + 1, "towardZero"), /q must/);
});

test("both exponent extremes survive Create and Quantize", () => {
  for (const exponent of [EXP_MIN, EXP_MAX]) {
    const field = Create(0, 777n, exponent);
    const view = field.parse();
    assert.equal(view.kind, "finite");
    if (view.kind !== "finite") {
      return;
    }
    assert.equal(view.exponent, exponent);
    const result = Quantize(field, exponent, "towardZero");
    assert.equal(result.status, "ok");
    if (result.status !== "ok") {
      return;
    }
    assert.equal(result.exponent, exponent);
    assert.equal(result.coefficient, 777n);
    assert.equal(result.rounded, false);
    assert.equal(result.inexact, false);
  }
});

test("equal values with different quanta compare equal, and ordering is exact", () => {
  const a = Create(0, 123n, 2);
  const b = Create(0, 1230n, 1);
  const c = Create(0, 12300n, 0);
  assert.equal(NumericCompare(a, b), "equal");
  assert.equal(NumericCompare(b, c), "equal");
  assert.equal(NumericCompare(a, c), "equal");

  const negA = Create(1, 123n, 2);
  const negB = Create(1, 1230n, 1);
  assert.equal(NumericCompare(negA, negB), "equal");
  assert.equal(NumericCompare(negA, a), "less");
  assert.equal(NumericCompare(a, negA), "greater");

  const small = Create(0, 999n, 0);
  const large = Create(0, 1n, 3);
  assert.equal(NumericCompare(small, large), "less");
  assert.equal(NumericCompare(large, small), "greater");
});

test("infinity and NaN follow comparison rules while raw bytes pass through", () => {
  const negInf = fromBytes(
    assemble(SIGN_BIT | (30n << 58n) | 0xabcdefn, 0x0123456789abcdefn),
  );
  const posInf = fromBytes(assemble((30n << 58n) | 0x11n, 0xfedcba9876543210n));
  const nan = fromBytes(
    assemble((31n << 58n) | 0x0042n, 0x13579bdf2468acen),
  );

  assert.equal(negInf.parse().kind, "infinity");
  assert.equal(posInf.parse().kind, "infinity");
  assert.equal(nan.parse().kind, "nan");

  const finite = Create(0, MAX_COEFF, EXP_MAX);
  assert.equal(NumericCompare(negInf, finite), "less");
  assert.equal(NumericCompare(finite, negInf), "greater");
  assert.equal(NumericCompare(finite, posInf), "less");
  assert.equal(NumericCompare(posInf, finite), "greater");
  assert.equal(NumericCompare(negInf, negInf), "equal");
  assert.equal(NumericCompare(posInf, posInf), "equal");
  assert.equal(NumericCompare(nan, finite), "unordered");
  assert.equal(NumericCompare(finite, nan), "unordered");
  assert.equal(NumericCompare(nan, nan), "unordered");
  assert.equal(NumericCompare(nan, posInf), "unordered");

  for (const special of [negInf, posInf, nan]) {
    for (const mode of MODES) {
      const result = Quantize(special, 0, mode);
      assert.equal(result.status, "notFinite");
      if (result.status !== "notFinite") {
        return;
      }
      assert.ok(bytesEqual(result.field.rawBytes(), special.rawBytes()));
    }
  }

  const nanSnapshot = nan.rawBytes();
  nanSnapshot[0] = (nanSnapshot[0] ?? 0) ^ 0xff;
  assert.ok(!bytesEqual(nan.rawBytes(), nanSnapshot));
});

function lcg(seed: bigint): () => bigint {
  let state = seed & ((1n << 64n) - 1n);
  return () => {
    state = (state * 6364136223846793005n + 1442695040888963407n) & ((1n << 64n) - 1n);
    return state;
  };
}

test("all rounding modes agree with the independent numerator/denominator reference", () => {
  const next = lcg(0xc0ffee123456789n);
  const coefficientChoices = [
    0n,
    1n,
    5n,
    12345n,
    9999999n,
    10n ** 20n,
    10n ** 33n,
    MAX_COEFF,
    MAX_COEFF - 1n,
  ];
  const exponentChoices = [EXP_MIN, -100, -7, -1, 0, 1, 7, 100, EXP_MAX];
  const targetChoices = [EXP_MIN, -50, -3, -1, 0, 1, 3, 50, EXP_MAX];

  for (let iteration = 0; iteration < 120; iteration += 1) {
    const coefficient =
      iteration < coefficientChoices.length
        ? (coefficientChoices[iteration] as bigint)
        : next() % (10n ** 30n);
    const sign = (next() & 1n) === 1n ? 1 : 0;
    const exponent = exponentChoices[
      Number(next() % BigInt(exponentChoices.length))
    ] as number;
    const field = Create(sign, coefficient, exponent);

    for (const target of targetChoices) {
      for (const mode of MODES) {
        const actual = Quantize(field, target, mode);
        const expected = referenceQuantize(field, target, mode);
        assert.equal(
          actual.status,
          expected.status,
          `status mismatch c=${coefficient} sign=${sign} e=${exponent} q=${target} mode=${mode}`,
        );
        if (actual.status !== "ok" || expected.status !== "ok") {
          continue;
        }
        assert.deepEqual(
          {
            sign: actual.sign,
            coefficient: actual.coefficient,
            exponent: actual.exponent,
            rounded: actual.rounded,
            inexact: actual.inexact,
            nonCanonical: actual.sourceNonCanonical,
          },
          {
            sign: expected.sign,
            coefficient: expected.coefficient,
            exponent: expected.exponent,
            rounded: expected.rounded,
            inexact: expected.inexact,
            nonCanonical: expected.sourceNonCanonical,
          },
        );

        // Exact value identity: sign * C * 10^e is preserved when inexact=false.
        if (!actual.inexact) {
          assert.equal(NumericCompare(field, actual.field), "equal");
        }
        const reView = actual.field.parse();
        assert.equal(reView.kind, "finite");
        if (reView.kind === "finite") {
          assert.equal(reView.exponent, target);
          assert.equal(reView.nonCanonical, false);
        }
      }
    }
  }
});

test("reference comparison matches NumericCompare over a constructed ordering set", () => {
  const set = [
    Create(1, MAX_COEFF, EXP_MAX),
    Create(1, 1n, EXP_MIN),
    Create(1, 123n, -5),
    Create(1, 0n, -99),
    Create(0, 0n, 42),
    Create(0, 1n, EXP_MIN),
    Create(0, 123n, -5),
    Create(0, 1230n, -6),
    Create(0, 1n, 3),
    Create(0, MAX_COEFF, EXP_MAX),
  ];

  for (const left of set) {
    for (const right of set) {
      assert.equal(
        NumericCompare(left, right),
        referenceCompare(left, right),
      );
    }
  }
});

test("Quantize output is a separate field and the source snapshot is immutable", () => {
  const source = Create(1, 123456n, -2);
  const originalBytes = source.rawBytes();
  const result = Quantize(source, 0, "nearestEven");
  assert.equal(result.status, "ok");
  if (result.status !== "ok") {
    return;
  }
  assert.ok(!bytesEqual(source.rawBytes(), result.field.rawBytes()));
  assert.ok(bytesEqual(source.rawBytes(), originalBytes));

  const handedOut = source.rawBytes();
  handedOut.fill(0);
  assert.ok(bytesEqual(source.rawBytes(), originalBytes));

  assert.throws(() => new Uint8Array(15) && fromBytes(new Uint8Array(15)), /16 bytes/);
  assert.throws(() => fromBytes(new Uint8Array(17)), /16 bytes/);
  assert.throws(
    () => Quantize(source, 0, "bogus" as RoundingMode),
    /rounding mode/,
  );
});
