import test from "node:test";
import assert from "node:assert/strict";
import { applyDiff, deepEqual, digest, getAtPath, makeResolution, merge3, pathKey, } from "../src/index.js";
const base = {
    title: "demo",
    count: 1,
    profile: { name: "ann", age: 30 },
    tags: ["a"],
};
test("no changes: merged equals base, clean, empty diff", () => {
    const r = merge3({ base, ours: structuredClone(base), theirs: structuredClone(base) });
    assert.ok(r.clean);
    assert.deepEqual(r.merged, base);
    assert.equal(r.conflicts.length, 0);
    assert.equal(r.diff.length, 0);
});
test("one-side change is taken without conflict", () => {
    const ours = { ...structuredClone(base), count: 2 };
    const r = merge3({ base, ours, theirs: structuredClone(base) });
    assert.ok(r.clean);
    assert.equal(r.merged.count, 2);
    assert.deepEqual(r.diff.map((d) => d.displayPath), ['"count"']);
});
test("both sides same change: no conflict", () => {
    const change = structuredClone(base);
    change.title = "v2";
    const r = merge3({ base, ours: structuredClone(change), theirs: structuredClone(change) });
    assert.ok(r.clean);
    assert.equal(r.merged.title, "v2");
});
test("conflict carries provenance: values, digests, origin", () => {
    const ours = { ...structuredClone(base), count: 10 };
    const theirs = { ...structuredClone(base), count: 20 };
    const r = merge3({ base, ours, theirs });
    assert.equal(r.clean, false);
    assert.equal(r.conflicts.length, 1);
    const c = r.conflicts[0];
    assert.equal(c.status, "pending");
    assert.equal(c.displayPath, '"count"');
    assert.equal(c.origin, "both");
    assert.equal(c.base, 1);
    assert.equal(c.ours, 10);
    assert.equal(c.theirs, 20);
    assert.equal(c.oursDigest, digest(10));
    assert.equal(c.theirsDigest, digest(20));
    assert.equal(c.baseDigest, digest(1));
});
test("resolution binds both sides' digests and applies while they match", () => {
    const ours = { ...structuredClone(base), count: 10 };
    const theirs = { ...structuredClone(base), count: 20 };
    const res = makeResolution(["count"], { kind: "theirs" }, { base, ours, theirs });
    assert.equal(res.oursDigest, digest(10));
    assert.equal(res.theirsDigest, digest(20));
    const r = merge3({ base, ours, theirs, resolutions: [res] });
    assert.ok(r.clean);
    assert.equal(r.merged.count, 20);
    assert.equal(r.applied.length, 1);
    assert.equal(r.applied[0].displayPath, '"count"');
});
test("custom choice applies an explicit value", () => {
    const ours = { ...structuredClone(base), count: 10 };
    const theirs = { ...structuredClone(base), count: 20 };
    const res = makeResolution(["count"], { kind: "custom", value: 15 }, { base, ours, theirs });
    const r = merge3({ base, ours, theirs, resolutions: [res] });
    assert.ok(r.clean);
    assert.equal(r.merged.count, 15);
});
test("stale resolution reopens the conflict when ours moves", () => {
    const ours = { ...structuredClone(base), count: 10 };
    const theirs = { ...structuredClone(base), count: 20 };
    const res = makeResolution(["count"], { kind: "theirs" }, { base, ours, theirs });
    const ours2 = { ...structuredClone(base), count: 11 };
    const r = merge3({ base, ours: ours2, theirs, resolutions: [res] });
    assert.equal(r.clean, false);
    assert.equal(r.applied.length, 0);
    const c = r.conflicts[0];
    assert.equal(c.status, "reopened");
    assert.equal(c.staleReason, "ours-changed");
    assert.equal(c.ours, 11);
    assert.equal(c.staleResolution, res);
});
test("stale resolution reopens when theirs moves; both moving reports both-changed", () => {
    const ours = { ...structuredClone(base), count: 10 };
    const theirs = { ...structuredClone(base), count: 20 };
    const res = makeResolution(["count"], { kind: "ours" }, { base, ours, theirs });
    const r1 = merge3({ base, ours, theirs: { ...structuredClone(base), count: 21 }, resolutions: [res] });
    assert.equal(r1.conflicts[0].staleReason, "theirs-changed");
    const r2 = merge3({
        base,
        ours: { ...structuredClone(base), count: 11 },
        theirs: { ...structuredClone(base), count: 21 },
        resolutions: [res],
    });
    assert.equal(r2.conflicts[0].staleReason, "both-changed");
});
test("resolutions on different fields carry over independently", () => {
    const ours = { ...structuredClone(base), count: 10, title: "ours" };
    const theirs = { ...structuredClone(base), count: 20, title: "theirs" };
    const countRes = makeResolution(["count"], { kind: "ours" }, { base, ours, theirs });
    // Later, only `title` sources change; `count` resolution must still apply.
    const ours2 = { ...ours, title: "ours-v2" };
    const theirs2 = { ...theirs, title: "theirs-v2" };
    const r = merge3({ base, ours: ours2, theirs: theirs2, resolutions: [countRes] });
    assert.equal(r.merged.count, 10);
    assert.deepEqual(r.applied.map((a) => a.displayPath), ['"count"']);
    assert.deepEqual(r.conflicts.map((c) => c.displayPath), ['"title"']);
    assert.equal(r.conflicts[0].status, "pending");
});
test("nested field resolution survives sibling changes under the same parent", () => {
    const ours = structuredClone(base);
    const theirs = structuredClone(base);
    ours.profile.name = "ann-ours";
    theirs.profile.name = "ann-theirs";
    const nameRes = makeResolution(["profile", "name"], { kind: "custom", value: "ann-final" }, { base, ours, theirs });
    const ours2 = structuredClone(ours);
    ours2.profile.age = 31;
    const r = merge3({ base, ours: ours2, theirs, resolutions: [nameRes] });
    assert.ok(r.clean);
    const profile = r.merged.profile;
    assert.equal(profile.name, "ann-final");
    assert.equal(profile.age, 31);
});
test("removal vs modification conflicts and resolves to removal", () => {
    const ours = structuredClone(base);
    delete ours["tags"];
    const theirs = { ...structuredClone(base), tags: ["a", "b"] };
    const res = makeResolution(["tags"], { kind: "ours" }, { base, ours: ours, theirs });
    const r = merge3({ base, ours: ours, theirs, resolutions: [res] });
    assert.ok(r.clean);
    assert.equal(getAtPath(r.merged, ["tags"]), undefined);
    assert.deepEqual(r.diff.map((d) => `${d.op}:${d.displayPath}`), ['remove:"tags"']);
});
test("final diff applies back to base to reproduce merged", () => {
    const ours = { ...structuredClone(base), count: 10, extra: { x: 1 } };
    const theirs = { ...structuredClone(base), count: 20, title: "t2" };
    const res = makeResolution(["count"], { kind: "custom", value: 99 }, { base, ours, theirs });
    const r = merge3({ base, ours, theirs, resolutions: [res] });
    assert.ok(r.clean);
    const rebuilt = applyDiff(base, r.diff);
    assert.ok(deepEqual(rebuilt, r.merged));
});
test("resolution keys are exact per path; similar paths do not collide", () => {
    const ours = { ...structuredClone(base), count: 10, title: "o" };
    const theirs = { ...structuredClone(base), count: 20, title: "t" };
    const resolutions = [
        makeResolution(["count"], { kind: "ours" }, { base, ours, theirs }),
        makeResolution(["title"], { kind: "theirs" }, { base, ours, theirs }),
    ];
    const r = merge3({ base, ours, theirs, resolutions });
    assert.ok(r.clean);
    assert.equal(r.merged.count, 10);
    assert.equal(r.merged.title, "t");
    assert.notEqual(pathKey(["count"]), pathKey(["title"]));
});
