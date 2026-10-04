import test from "node:test";
import assert from "node:assert/strict";
import { applyDiff, canonicalize, deepEqual, getAtPath, makeResolution, matchResolution, merge3, pathKey, pickValue, } from "../src/index.js";
/** Deterministic PRNG (mulberry32) so failures reproduce from the seed. */
function rng(seed) {
    let a = seed >>> 0;
    return () => {
        a |= 0;
        a = (a + 0x6d2b79f5) | 0;
        let t = Math.imul(a ^ (a >>> 15), 1 | a);
        t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}
const KEYS = ["alpha", "beta", "gamma", "delta", "eps"];
const NESTED = ["nest", "cfg"];
function randomScalar(rand) {
    const pick = rand();
    if (pick < 0.4)
        return Math.floor(rand() * 100);
    if (pick < 0.7)
        return "s" + Math.floor(rand() * 10);
    if (pick < 0.85)
        return rand() < 0.5;
    return null;
}
function randomDoc(rand) {
    const doc = {};
    for (const k of KEYS)
        if (rand() < 0.7)
            doc[k] = randomScalar(rand);
    for (const n of NESTED) {
        if (rand() < 0.6) {
            const inner = {};
            for (const k of KEYS.slice(0, 3))
                if (rand() < 0.6)
                    inner[k] = randomScalar(rand);
            doc[n] = inner;
        }
    }
    return doc;
}
/** Apply one random edit (set/delete, top-level or one level deep). */
function randomEdit(rand, doc) {
    const nested = rand() < 0.35;
    if (nested) {
        const n = NESTED[Math.floor(rand() * NESTED.length)];
        const cur = doc[n];
        const inner = cur !== null && typeof cur === "object" && !Array.isArray(cur) ? { ...cur } : {};
        const k = KEYS[Math.floor(rand() * 3)];
        if (rand() < 0.25)
            delete inner[k];
        else
            inner[k] = randomScalar(rand);
        doc[n] = inner;
    }
    else {
        const k = KEYS[Math.floor(rand() * KEYS.length)];
        if (rand() < 0.25)
            delete doc[k];
        else
            doc[k] = randomScalar(rand);
    }
}
function editedCopy(rand, doc, edits) {
    const copy = structuredClone(doc);
    for (let i = 0; i < edits; i++)
        randomEdit(rand, copy);
    return copy;
}
test("randomized branch updates: digest-bound resolutions keep/stale correctly on recompute", () => {
    const ROUNDS = 300;
    const stats = { rounds: 0, conflicts: 0, applied: 0, kept: 0, reopened: 0, vanished: 0 };
    for (let round = 0; round < ROUNDS; round++) {
        const rand = rng(0x9e3779b9 ^ (round * 2654435761));
        const base = randomDoc(rand);
        const ours = editedCopy(rand, base, 1 + Math.floor(rand() * 4));
        const theirs = editedCopy(rand, base, 1 + Math.floor(rand() * 4));
        // Round 1: merge, resolve every conflict with a random choice.
        const first = merge3({ base, ours, theirs });
        const resolutions = first.conflicts.map((c) => {
            const pick = rand();
            const choice = pick < 0.3
                ? { kind: "ours" }
                : pick < 0.6
                    ? { kind: "theirs" }
                    : pick < 0.8
                        ? { kind: "base" }
                        : { kind: "custom", value: randomScalar(rand) };
            return makeResolution(c.path, choice, { base, ours, theirs });
        });
        const settled = merge3({ base, ours, theirs, resolutions });
        assert.ok(settled.clean, `round ${round}: all conflicts resolved`);
        assert.equal(settled.applied.length, resolutions.length);
        // Random branch updates, then recompute with the same resolution book.
        const ours2 = editedCopy(rand, ours, 1 + Math.floor(rand() * 3));
        const theirs2 = editedCopy(rand, theirs, 1 + Math.floor(rand() * 3));
        const rerun = merge3({ base, ours: ours2, theirs: theirs2, resolutions });
        // Independent oracle: conflict paths without any resolutions.
        const bare = merge3({ base, ours: ours2, theirs: theirs2 });
        const bareConflictKeys = new Set(bare.conflicts.map((c) => pathKey(c.path)));
        const appliedByKey = new Map(rerun.applied.map((a) => [pathKey(a.path), a]));
        const conflictByKey = new Map(rerun.conflicts.map((c) => [pathKey(c.path), c]));
        const sources = { base, ours: ours2, theirs: theirs2 };
        for (const res of resolutions) {
            const key = pathKey(res.path);
            const stillValid = matchResolution(res, sources).matches;
            if (!bareConflictKeys.has(key)) {
                // Field no longer conflicts: resolution is simply not consulted.
                assert.ok(!appliedByKey.has(key), `round ${round}: applied at non-conflict ${key}`);
                assert.ok(!conflictByKey.has(key), `round ${round}: conflict at non-conflict ${key}`);
                stats.vanished++;
            }
            else if (stillValid) {
                // Digests still match: choice must carry over, even though other fields moved.
                const applied = appliedByKey.get(key);
                assert.ok(applied, `round ${round}: valid resolution not applied at ${key}`);
                const expected = pickValue(res.choice, sources, res.path);
                assert.ok(deepEqual(getAtPath(rerun.merged, res.path) ?? undefined, expected ?? undefined), `round ${round}: merged value mismatch at ${key}`);
                stats.kept++;
            }
            else {
                // Source moved: stale choice must be dropped and the conflict reopened.
                const conflict = conflictByKey.get(key);
                assert.ok(conflict, `round ${round}: stale resolution did not reopen ${key}`);
                assert.equal(conflict.status, "reopened");
                assert.equal(conflict.staleResolution, res);
                assert.ok(!appliedByKey.has(key), `round ${round}: stale resolution applied at ${key}`);
                stats.reopened++;
            }
        }
        // Every applied resolution is digest-valid; every pending conflict was never resolved.
        for (const a of rerun.applied) {
            assert.ok(matchResolution(a.resolution, sources).matches);
            stats.applied++;
        }
        for (const c of rerun.conflicts) {
            if (c.status === "pending")
                assert.ok(bareConflictKeys.has(pathKey(c.path)));
            stats.conflicts++;
        }
        // Final diff must reconstruct merged from base.
        assert.ok(deepEqual(applyDiff(base, rerun.diff), rerun.merged), `round ${round}: diff does not reproduce merged`);
        // Recompute determinism.
        const again = merge3({ base, ours: ours2, theirs: theirs2, resolutions });
        assert.equal(canonicalize(again.merged), canonicalize(rerun.merged));
        assert.equal(canonicalize(again.conflicts), canonicalize(rerun.conflicts));
        stats.rounds++;
    }
    assert.ok(stats.kept > 0, "expected some resolutions to carry over");
    assert.ok(stats.reopened > 0, "expected some resolutions to go stale");
    console.log(`randomized recompute check: ${JSON.stringify(stats)}`);
});
