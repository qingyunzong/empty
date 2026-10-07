import { offsetAt, ruleIndexAt, rules, } from "./table.js";
/** Forward map: UTC integer second -> local integer second. Always total. */
export function utcToLocal(table, utc) {
    const ruleIndex = ruleIndexAt(table, utc);
    const offsetSeconds = offsetAt(table, utc);
    return { utc, local: utc + offsetSeconds, offsetSeconds, ruleIndex };
}
/**
 * Reverse map: local integer second -> all UTC seconds that forward-map to it.
 * A UTC second u is a candidate for local L under rule r iff
 * u = L - offset_r and u lies in r's half-open UTC domain.
 */
export function localToUtc(table, local) {
    const candidates = [];
    for (const rule of rules(table)) {
        const utc = local - rule.offsetSeconds;
        if (utc >= rule.utcStart && utc < rule.utcEnd) {
            candidates.push({
                utc,
                offsetSeconds: rule.offsetSeconds,
                ruleIndex: rule.ruleIndex,
            });
        }
    }
    candidates.sort((a, b) => a.utc - b.utc);
    const kind = candidates.length === 0 ? "none" : candidates.length === 1 ? "unique" : "ambiguous";
    return { local, kind, candidates };
}
/**
 * Exhaustive per-UTC verification over the half-open domain [utcStart, utcEnd):
 * forward-map every UTC second, then confirm the reverse lookup of the
 * resulting local second contains the original UTC second.
 */
export function verifyRoundTrip(table, utcStart, utcEnd) {
    if (!(utcStart < utcEnd)) {
        throw new RangeError(`empty domain [${utcStart}, ${utcEnd})`);
    }
    const failures = [];
    for (let utc = utcStart; utc < utcEnd; utc += 1) {
        const { local } = utcToLocal(table, utc);
        const back = localToUtc(table, local);
        if (!back.candidates.some((c) => c.utc === utc)) {
            failures.push(utc);
        }
    }
    return { utcStart, utcEnd, checked: utcEnd - utcStart, failures };
}
