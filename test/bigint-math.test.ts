import test from "node:test";
import assert from "node:assert";
import { ceilDiv, crtMerge, floorDiv, gcd, mod, modInverse } from "../src/bigint-math";

test("floorDiv/ceilDiv handle all sign combinations exactly", () => {
  assert.equal(floorDiv(7n, 2n), 3n);
  assert.equal(floorDiv(-7n, 2n), -4n);
  assert.equal(floorDiv(7n, -2n), -4n);
  assert.equal(floorDiv(-7n, -2n), 3n);
  assert.equal(floorDiv(6n, 3n), 2n);
  assert.equal(floorDiv(-6n, 3n), -2n);
  assert.equal(ceilDiv(7n, 2n), 4n);
  assert.equal(ceilDiv(-7n, 2n), -3n);
  assert.equal(ceilDiv(7n, -2n), -3n);
  assert.equal(ceilDiv(-7n, -2n), 4n);
  assert.equal(ceilDiv(6n, 3n), 2n);
  assert.equal(ceilDiv(-6n, 3n), -2n);
});

test("floorDiv/ceilDiv on huge values beyond double precision", () => {
  const a = 9223372036854775796n; // 2^63 - 12, not representable as double
  assert.equal(floorDiv(a, 8n), 1152921504606846974n);
  assert.equal(ceilDiv(a, 8n), 1152921504606846975n);
  assert.equal(floorDiv(-a, 8n), -1152921504606846975n);
});

test("gcd and mod", () => {
  assert.equal(gcd(12n, 18n), 6n);
  assert.equal(gcd(-12n, 18n), 6n);
  assert.equal(gcd(0n, 5n), 5n);
  assert.equal(mod(-3n, 7n), 4n);
  assert.equal(mod(10n, 5n), 0n);
});

test("modInverse", () => {
  assert.equal(modInverse(3n, 7n), 5n);
  assert.equal(modInverse(2n, 4n), null);
  const big = modInverse(1000000007n, 1000000009n);
  assert.ok(big !== null);
  assert.equal((1000000007n * big!) % 1000000009n, 1n);
});

test("crtMerge consistent and conflicting", () => {
  const merged = crtMerge({ residue: 1n, modulus: 4n }, { residue: 3n, modulus: 6n });
  assert.ok("congruence" in merged);
  if ("congruence" in merged) {
    assert.equal(merged.congruence.residue, 9n);
    assert.equal(merged.congruence.modulus, 12n);
  }
  const conflict = crtMerge({ residue: 0n, modulus: 4n }, { residue: 3n, modulus: 6n });
  assert.ok("conflict" in conflict);
  if ("conflict" in conflict) assert.equal(conflict.conflict.gcd, 2n);
});
