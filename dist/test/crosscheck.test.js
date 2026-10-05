import { test, describe } from "node:test";
import { deepEqual } from "node:assert/strict";
import { findPath } from "../src/pathfinder.js";
import { findPathByEnumeration } from "../src/enumerate.js";
import { lcg } from "./helpers.js";
const USAGE_POOL = ["serverAuth", "clientAuth", "codeSigning", "emailProtection"];
function randomGraph(rand) {
    const count = 2 + Math.floor(rand() * 13); // 2..14 certificates
    const ids = Array.from({ length: count }, (_, i) => `C${String(i).padStart(2, "0")}`);
    const nodes = new Map();
    const validity = new Map();
    for (const id of ids) {
        const issuers = [];
        for (const other of ids) {
            if (other !== id && rand() < 0.18)
                issuers.push(other);
        }
        const usages = USAGE_POOL.filter(() => rand() < 0.7);
        nodes.set(id, { id, issuers, usages });
        validity.set(id, rand() < 0.8);
    }
    const trustedRoots = new Set(ids.filter(() => rand() < 0.25));
    return { graph: { nodes, validity, trustedRoots }, ids };
}
describe("cross-check: pruned search vs simple path enumeration", () => {
    test("agree on 600 randomized graphs and requests", () => {
        const rand = lcg(20261005);
        let found = 0;
        let failed = 0;
        for (let round = 0; round < 600; round += 1) {
            const { graph, ids } = randomGraph(rand);
            const leafId = ids[Math.floor(rand() * ids.length)];
            const usage = USAGE_POOL[Math.floor(rand() * USAGE_POOL.length)];
            const maxLength = 1 + Math.floor(rand() * 14); // 1..14, straddling the 12 limit
            const request = { leafId, usage, maxLength };
            const a = findPath(graph, request);
            const b = findPathByEnumeration(graph, request);
            deepEqual(a, b, `round ${round}: ${JSON.stringify(request)}`);
            if (a.ok)
                found += 1;
            else
                failed += 1;
        }
        // Sanity: the random corpus must exercise both outcomes.
        if (found === 0 || failed === 0) {
            throw new Error(`unbalanced corpus: found=${found} failed=${failed}`);
        }
    });
    test("agree on the default 12-certificate limit specifically", () => {
        const rand = lcg(12012);
        for (let round = 0; round < 300; round += 1) {
            const { graph, ids } = randomGraph(rand);
            const leafId = ids[Math.floor(rand() * ids.length)];
            const usage = USAGE_POOL[Math.floor(rand() * USAGE_POOL.length)];
            const request = { leafId, usage };
            deepEqual(findPath(graph, request), findPathByEnumeration(graph, request));
        }
    });
});
