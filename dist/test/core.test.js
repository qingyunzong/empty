import assert from "node:assert/strict";
import test from "node:test";
import { DEFAULT_CAP, MAX_STEPS, forward, invertChain, normalize, parseStep, roundHalfEvenDiv, verifyIntervals, } from "../src/core.js";
const step = (p, q) => ({ p, q });
test("roundHalfEvenDiv: ties go to even", () => {
    assert.equal(roundHalfEvenDiv(10n, 4n), 2n); // 2.5 -> 2
    assert.equal(roundHalfEvenDiv(14n, 4n), 4n); // 3.5 -> 4
    assert.equal(roundHalfEvenDiv(1n, 2n), 0n); // 0.5 -> 0
    assert.equal(roundHalfEvenDiv(3n, 2n), 2n); // 1.5 -> 2
    assert.equal(roundHalfEvenDiv(5n, 2n), 2n); // 2.5 -> 2
    assert.equal(roundHalfEvenDiv(7n, 2n), 4n); // 3.5 -> 4
});
test("roundHalfEvenDiv: non-tie fractions", () => {
    assert.equal(roundHalfEvenDiv(9n, 4n), 2n); // 2.25 -> 2
    assert.equal(roundHalfEvenDiv(11n, 4n), 3n); // 2.75 -> 3
    assert.equal(roundHalfEvenDiv(0n, 7n), 0n);
    assert.equal(roundHalfEvenDiv(100n, 10n), 10n);
});
test("forward: applies steps in order", () => {
    // 100 * 9/10 = 90 exactly; 90 * 4/5 = 72 exactly
    assert.equal(forward(100n, [step(9n, 10n), step(4n, 5n)]), 72n);
    // 105 * 9/10 = 94.5 -> 94 (even); 94 * 4/5 = 75.2 -> 75
    assert.equal(forward(105n, [step(9n, 10n), step(4n, 5n)]), 75n);
});
test("invertChain: single step, hand-computed", () => {
    // x * 1/2 rounds to 4: x/2 in [3.5, 4.5); ties: 3.5 -> 4 (even, included),
    // 4.5 -> 4 (even, included) => x in [7, 9]
    assert.deepEqual(invertChain(4n, [step(1n, 2n)]), [{ lo: 7n, hi: 9n }]);
    // rounds to 3: 2.5 -> 2 (even, excluded), 3.5 -> 4 (even, excluded) => x = 6
    assert.deepEqual(invertChain(3n, [step(1n, 2n)]), [{ lo: 6n, hi: 6n }]);
    // rounds to 0: x/2 < 0.5 or == 0.5 (tie -> 0 even) => x in [0, 1]
    assert.deepEqual(invertChain(0n, [step(1n, 2n)]), [{ lo: 0n, hi: 1n }]);
});
test("invertChain: empty when amount unreachable", () => {
    // doubling map x -> 2x never yields an odd amount
    assert.deepEqual(invertChain(3n, [step(2n, 1n)]), []);
    assert.deepEqual(invertChain(4n, [step(2n, 1n)]), [{ lo: 2n, hi: 2n }]);
});
test("invertChain: clamps to cap", () => {
    const iv = invertChain(0n, [step(1n, 100n)], 10n);
    assert.deepEqual(iv, [{ lo: 0n, hi: 10n }]); // preimage would run to 49
});
test("invertChain: default cap is 10^12", () => {
    const iv = invertChain(0n, [step(1n, 10n ** 15n)]);
    assert.deepEqual(iv, [{ lo: 0n, hi: DEFAULT_CAP }]);
});
test("invertChain: rejects bad chain lengths", () => {
    assert.throws(() => invertChain(1n, []), /chain length/);
    const nine = Array.from({ length: MAX_STEPS + 1 }, () => step(1n, 2n));
    assert.throws(() => invertChain(1n, nine), /chain length/);
});
test("invertChain: 8-step chain works", () => {
    const steps = Array.from({ length: 8 }, () => step(9n, 10n));
    const iv = invertChain(100n, steps);
    assert.equal(iv.length, 1);
    const report = verifyIntervals(100n, steps, iv);
    assert.ok(report.ok, report.failures.join("; "));
});
test("parseStep: accepts p/q and bare integers", () => {
    assert.deepEqual(parseStep("9/10"), { p: 9n, q: 10n });
    assert.deepEqual(parseStep("3"), { p: 3n, q: 1n });
    assert.throws(() => parseStep("0/5"), /numerator/);
    assert.throws(() => parseStep("5/0"), /denominator/);
    assert.throws(() => parseStep("a/b"), /invalid step/);
});
test("normalize: merges overlapping and adjacent integer intervals", () => {
    const merged = normalize([
        { lo: 10n, hi: 12n },
        { lo: 0n, hi: 4n },
        { lo: 5n, hi: 7n }, // adjacent to [0,4]
        { lo: 11n, hi: 20n }, // overlaps [10,12]
    ], 100n);
    assert.deepEqual(merged, [
        { lo: 0n, hi: 7n },
        { lo: 10n, hi: 20n },
    ]);
});
/**
 * Brute-force ground truth: forward-evaluate every x in [0, N] and collect,
 * per reachable amount, the exact set of originals (asserted contiguous).
 */
function bruteForce(steps, N) {
    const map = new Map();
    for (let x = 0n; x <= N; x++) {
        const y = forward(x, steps);
        const cur = map.get(y);
        if (cur === undefined) {
            map.set(y, { lo: x, hi: x });
        }
        else {
            assert.equal(x, cur.hi + 1n, `preimage of ${y} is not contiguous at x=${x}`);
            map.set(y, { lo: cur.lo, hi: x });
        }
    }
    return map;
}
function mulberry32(seed) {
    let a = seed >>> 0;
    return () => {
        a |= 0;
        a = (a + 0x6d2b79f5) | 0;
        let t = Math.imul(a ^ (a >>> 15), 1 | a);
        t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}
test("low price domain: per-value forward verification against brute force", () => {
    const rand = mulberry32(20261008);
    const N = 3000n;
    let cases = 0;
    for (let trial = 0; trial < 400; trial++) {
        const len = 1 + Math.floor(rand() * MAX_STEPS);
        const steps = Array.from({ length: len }, () => step(BigInt(1 + Math.floor(rand() * 20)), BigInt(1 + Math.floor(rand() * 20))));
        const truth = bruteForce(steps, N);
        for (const [amount, iv] of truth) {
            // skip preimages truncated by the brute-force horizon
            if (iv.hi === N)
                continue;
            const got = invertChain(amount, steps).filter((x) => x.lo <= N);
            const clipped = got.map((g) => ({ lo: g.lo, hi: g.hi > N ? N : g.hi }));
            assert.deepEqual(clipped, [iv], `steps=${steps.map((s) => `${s.p}/${s.q}`).join(",")} amount=${amount}`);
            // exhaustive per-value forward verification of the inverted interval
            const report = verifyIntervals(amount, steps, clipped, N, N);
            assert.ok(report.ok, report.failures.join("; "));
            assert.ok(report.exhaustive);
            cases++;
        }
    }
    assert.ok(cases > 5000, `too few cases exercised: ${cases}`);
});
test("verifyIntervals: detects a wrong interval", () => {
    const steps = [step(1n, 2n)];
    const report = verifyIntervals(4n, steps, [{ lo: 7n, hi: 10n }], DEFAULT_CAP, 100n);
    assert.equal(report.ok, false);
    assert.ok(report.failures.some((f) => f.startsWith("x=10")));
});
