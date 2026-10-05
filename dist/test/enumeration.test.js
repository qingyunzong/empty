import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { splitDetailed, squaredDeviation, InfeasibleError, } from "../src/split.js";
import { mulberry32, randInt, bruteForceMinCost, bruteForceMinCostMITM, toRecipients, } from "./helpers.js";
function randomRecipients(rng, n, maxWeight, maxBound) {
    const rs = [];
    for (let i = 0; i < n; i++) {
        const min = randInt(rng, 0, 3);
        const max = min + randInt(rng, 0, maxBound);
        rs.push({ id: i, w: randInt(rng, 0, maxWeight), min, max });
    }
    return rs;
}
describe("exhaustive-enumeration cross-check", () => {
    test("small amounts: split matches full enumeration (min deviation + conservation)", () => {
        const rng = mulberry32(20261005);
        let feasible = 0;
        let infeasible = 0;
        for (let iter = 0; iter < 400; iter++) {
            const n = randInt(rng, 1, 4);
            const total = randInt(rng, 0, 12);
            const rs = randomRecipients(rng, n, 8, 6);
            const minSum = rs.reduce((s, r) => s + r.min, 0);
            const maxSum = rs.reduce((s, r) => s + Math.min(r.max, total), 0);
            const recipients = toRecipients(rs);
            if (minSum > total || maxSum < total) {
                infeasible++;
                assert.throws(() => splitDetailed(total, recipients), (err) => err instanceof InfeasibleError, `infeasible case must throw (iter ${iter})`);
                continue;
            }
            feasible++;
            const entries = splitDetailed(total, recipients);
            const amounts = new Map(entries.map((e) => [e.id, e.amount]));
            // conservation
            assert.equal(entries.reduce((s, e) => s + e.amount, 0), total, `conservation (iter ${iter})`);
            // bounds respected
            for (const r of rs) {
                const v = amounts.get(r.id);
                assert.ok(v >= r.min && v <= r.max, `bounds (iter ${iter})`);
            }
            // optimality: exact squared deviation equals the enumeration minimum
            const best = bruteForceMinCost(rs, total);
            assert.ok(best !== null);
            const got = squaredDeviation(total, recipients, amounts);
            assert.equal(got, best, `optimal deviation (iter ${iter})`);
            // determinism
            const again = splitDetailed(total, recipients);
            assert.deepEqual(again, entries, `deterministic (iter ${iter})`);
        }
        assert.ok(feasible > 200, `enough feasible cases (got ${feasible})`);
        assert.ok(infeasible > 20, `enough infeasible cases (got ${infeasible})`);
    });
    test("8 recipients, 100 cents: split matches meet-in-the-middle full enumeration", () => {
        const rng = mulberry32(800100);
        let checked = 0;
        for (let iter = 0; iter < 6; iter++) {
            const rs = randomRecipients(rng, 8, 20, 40);
            const total = 100;
            const minSum = rs.reduce((s, r) => s + r.min, 0);
            const maxSum = rs.reduce((s, r) => s + Math.min(r.max, total), 0);
            if (minSum > total || maxSum < total)
                continue; // keep feasible only
            const recipients = toRecipients(rs);
            const entries = splitDetailed(total, recipients);
            assert.equal(entries.reduce((s, e) => s + e.amount, 0), total, `conservation (iter ${iter})`);
            const best = bruteForceMinCostMITM(rs, total);
            assert.ok(best !== null);
            const got = squaredDeviation(total, recipients, new Map(entries.map((e) => [e.id, e.amount])));
            assert.equal(got, best, `optimal deviation (iter ${iter})`);
            checked++;
        }
        assert.ok(checked >= 3, `enough feasible 8-recipient cases (got ${checked})`);
    });
});
