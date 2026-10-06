"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.shrink = shrink;
exports.walkPath = walkPath;
/**
 * Greedy shrinker. A candidate is accepted ONLY if `fails` returns true
 * for it, i.e. the property is re-executed and genuinely still fails.
 * Candidates that pass (or throw differently, etc.) are rejected and
 * recorded in the trace as rejected.
 */
function shrink(tree, fails) {
    const trace = [];
    const acceptedPath = [];
    let attempts = 0;
    let current = tree;
    outer: while (true) {
        let index = 0;
        for (const child of current.shrinks()) {
            attempts++;
            const stillFails = fails(child.value);
            trace.push({ candidate: child.value, accepted: stillFails });
            if (stillFails) {
                acceptedPath.push(index);
                current = child;
                continue outer;
            }
            index++;
        }
        return { minimal: current.value, trace, acceptedPath, attempts };
    }
}
/** Walk a shrink path (child indices) from a root tree. */
function walkPath(tree, path) {
    let current = tree;
    for (const index of path) {
        let i = 0;
        let next;
        for (const child of current.shrinks()) {
            if (i === index) {
                next = child;
                break;
            }
            i++;
        }
        if (next === undefined) {
            throw new Error(`shrink path exhausted at index ${index}`);
        }
        current = next;
    }
    return current;
}
