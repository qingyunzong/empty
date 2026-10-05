"use strict";
/**
 * Persistent (versioned) mutable integer array with range-mode queries.
 *
 * - Every block update is atomic: it builds a fully-applied new version and
 *   appends it; the source version is never mutated.
 * - Old versions remain queryable forever (immutable snapshots).
 * - Range mode = most frequent value in [start, end); ties break to the
 *   smaller value. The query returns the value plus its frequency as
 *   evidence. Empty ranges return null.
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.PersistentModeArray = void 0;
function assertInteger(value, name) {
    if (!Number.isInteger(value)) {
        throw new TypeError(`${name} must be an integer, got ${value}`);
    }
}
function assertRange(length, start, end) {
    assertInteger(start, "start");
    assertInteger(end, "end");
    if (start < 0 || end > length || start > end) {
        throw new RangeError(`invalid range [${start}, ${end}) for array of length ${length}`);
    }
}
class PersistentModeArray {
    versions = [];
    constructor(initial) {
        for (const v of initial)
            assertInteger(v, "element");
        this.versions.push(Object.freeze(initial.slice()));
    }
    /** Number of versions (ids are 0 .. versionCount - 1). */
    get versionCount() {
        return this.versions.length;
    }
    /** Id of the most recent version. */
    get latestVersion() {
        return this.versions.length - 1;
    }
    /** Immutable snapshot of a version (throws on unknown version id). */
    snapshot(version) {
        const snap = this.versions[version];
        if (snap === undefined) {
            throw new RangeError(`unknown version ${version}`);
        }
        return snap;
    }
    /**
     * Atomic block update: set every index in [start, end) of `version` to
     * `value`, producing a new version. Returns the new version id.
     * The source version is left untouched and stays queryable.
     */
    replaceRange(version, start, end, value) {
        const base = this.snapshot(version);
        assertRange(base.length, start, end);
        assertInteger(value, "value");
        const next = base.slice();
        next.fill(value, start, end); // applied in full before publish => atomic
        this.versions.push(Object.freeze(next));
        return this.versions.length - 1;
    }
    /**
     * Mode of [start, end) in the given version: highest frequency wins,
     * ties break to the smaller value. Returns null for an empty range.
     */
    queryMode(version, start, end) {
        const snap = this.snapshot(version);
        assertRange(snap.length, start, end);
        if (start === end)
            return null;
        const freq = new Map();
        let best = null;
        for (let i = start; i < end; i++) {
            const v = snap[i];
            const c = (freq.get(v) ?? 0) + 1;
            freq.set(v, c);
            if (best === null || c > best.count || (c === best.count && v < best.value)) {
                best = { value: v, count: c };
            }
        }
        return best;
    }
}
exports.PersistentModeArray = PersistentModeArray;
