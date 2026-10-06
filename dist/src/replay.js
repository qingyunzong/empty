"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.replayFailure = replayFailure;
exports.deepEqual = deepEqual;
const rng_1 = require("./rng");
const shrink_1 = require("./shrink");
/**
 * Deterministically regenerate the failing case from the persisted
 * integer state (runSeed + size), re-walk the recorded shrink path,
 * and confirm the final counterexample genuinely still fails.
 */
function replayFailure(record, gen, check) {
    const rng = new rng_1.Rng(record.runSeed);
    const tree = gen(rng, record.size);
    const finalTree = (0, shrink_1.walkPath)(tree, record.shrinkPath);
    const counterexample = finalTree.value;
    let stillFails;
    try {
        stillFails = !check(counterexample);
    }
    catch {
        stillFails = true;
    }
    return {
        reproduced: stillFails,
        counterexample,
        matchesRecord: deepEqual(counterexample, record.counterexample),
    };
}
function deepEqual(a, b) {
    if (Object.is(a, b))
        return true;
    if (typeof a !== typeof b || a === null || b === null)
        return false;
    if (Array.isArray(a) && Array.isArray(b)) {
        return a.length === b.length && a.every((x, i) => deepEqual(x, b[i]));
    }
    if (typeof a === "object") {
        const ka = Object.keys(a);
        const kb = Object.keys(b);
        return (ka.length === kb.length &&
            ka.every((k) => deepEqual(a[k], b[k])));
    }
    return false;
}
