function assertIntegerSeconds(value, what) {
    if (typeof value !== "number" || !Number.isInteger(value)) {
        throw new RangeError(`${what} must be an integer second, got ${value}`);
    }
}
/**
 * Validates and deep-freezes a transition table.
 * Transitions must be strictly increasing in atUtc. A transition may repeat
 * the current offset (a redundant no-op rule); such rules are kept so table
 * revisions stay faithful to their input, and inverse-image merging treats
 * them as equivalent segments.
 */
export function createTransitionTable(initialOffsetSeconds, transitions) {
    assertIntegerSeconds(initialOffsetSeconds, "initialOffsetSeconds");
    let previousAt = Number.NEGATIVE_INFINITY;
    const frozen = transitions.map((t, i) => {
        assertIntegerSeconds(t.atUtc, `transitions[${i}].atUtc`);
        assertIntegerSeconds(t.offsetSeconds, `transitions[${i}].offsetSeconds`);
        if (t.atUtc <= previousAt) {
            throw new RangeError(`transitions must be strictly increasing in atUtc (index ${i}: ${t.atUtc} <= ${previousAt})`);
        }
        previousAt = t.atUtc;
        return Object.freeze({ atUtc: t.atUtc, offsetSeconds: t.offsetSeconds });
    });
    return Object.freeze({
        initialOffsetSeconds,
        transitions: Object.freeze(frozen),
    });
}
export function ruleCount(table) {
    return table.transitions.length + 1;
}
export function ruleAt(table, ruleIndex) {
    const count = ruleCount(table);
    if (!Number.isInteger(ruleIndex) || ruleIndex < 0 || ruleIndex >= count) {
        throw new RangeError(`ruleIndex ${ruleIndex} out of range [0, ${count})`);
    }
    const before = ruleIndex === 0 ? undefined : table.transitions[ruleIndex - 1];
    const after = ruleIndex === count - 1 ? undefined : table.transitions[ruleIndex];
    return {
        ruleIndex,
        offsetSeconds: ruleIndex === 0 ? table.initialOffsetSeconds : before.offsetSeconds,
        utcStart: before === undefined ? Number.NEGATIVE_INFINITY : before.atUtc,
        utcEnd: after === undefined ? Number.POSITIVE_INFINITY : after.atUtc,
    };
}
export function* rules(table) {
    for (let i = 0; i < ruleCount(table); i += 1) {
        yield ruleAt(table, i);
    }
}
/** Index of the offset rule in effect at the given UTC second (binary search). */
export function ruleIndexAt(table, utc) {
    const ts = table.transitions;
    let lo = 0;
    let hi = ts.length; // search over transitions; answer is count of atUtc <= utc
    while (lo < hi) {
        const mid = (lo + hi) >> 1;
        if (ts[mid].atUtc <= utc) {
            lo = mid + 1;
        }
        else {
            hi = mid;
        }
    }
    return lo; // 0 => initial rule, k => transitions[k-1]
}
/** Offset (seconds ahead of UTC) in effect at the given UTC second. */
export function offsetAt(table, utc) {
    const idx = ruleIndexAt(table, utc);
    return idx === 0
        ? table.initialOffsetSeconds
        : table.transitions[idx - 1].offsetSeconds;
}
