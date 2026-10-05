import { canonicalizeComponent } from './percent.js';
/** Byte-wise comparison; canonical components are pure ASCII so code-unit
 * order equals byte order. */
function compareBytes(a, b) {
    return a < b ? -1 : a > b ? 1 : 0;
}
/**
 * Canonicalize a query string:
 *  - split on `&`, then on the first `=` (a pair without `=` keeps its
 *    value-less form),
 *  - strict percent handling on keys and values (unreserved decoded, reserved
 *    kept encoded, invalid escapes reject everything),
 *  - duplicate keys are preserved,
 *  - pairs are sorted by key bytes, then value bytes; ties keep the original
 *    relative order (stable).
 */
export function canonicalizeQuery(rawQuery, queryOffset, steps) {
    if (rawQuery === '') {
        steps.push('query: empty query string canonicalizes to empty');
        return { query: '', params: [], pieces: [] };
    }
    const pairs = [];
    let start = 0;
    let origIndex = 0;
    for (let i = 0; i <= rawQuery.length; i++) {
        if (i === rawQuery.length || rawQuery[i] === '&') {
            const raw = rawQuery.slice(start, i);
            const absStart = queryOffset + start;
            const absEnd = queryOffset + i;
            const eq = raw.indexOf('=');
            const rawKey = eq < 0 ? raw : raw.slice(0, eq);
            const rawValue = eq < 0 ? '' : raw.slice(eq + 1);
            const where = `query pair #${origIndex} '${raw}'`;
            const key = canonicalizeComponent(rawKey, `${where} key`, steps);
            const value = eq < 0 ? '' : canonicalizeComponent(rawValue, `${where} value`, steps);
            pairs.push({ key, value, hasValue: eq >= 0, raw, start: absStart, end: absEnd, origIndex });
            start = i + 1;
            origIndex++;
        }
    }
    const keyCounts = new Map();
    for (const pair of pairs)
        keyCounts.set(pair.key, (keyCounts.get(pair.key) ?? 0) + 1);
    for (const [key, count] of keyCounts) {
        if (count > 1)
            steps.push(`query: key '${key}' appears ${count} times — duplicates preserved`);
    }
    const sorted = [...pairs].sort((a, b) => compareBytes(a.key, b.key) || compareBytes(a.value, b.value) || a.origIndex - b.origIndex);
    steps.push(`query: sorted ${sorted.length} pair(s) by (key, value) byte order`);
    const params = [];
    const pieces = [];
    const parts = [];
    let cursor = 0;
    sorted.forEach((pair, index) => {
        const text = pair.hasValue ? `${pair.key}=${pair.value}` : pair.key;
        if (index > 0) {
            pieces.push({ canonStart: cursor, canonEnd: cursor + 1, origStart: pair.start, origEnd: pair.start });
            cursor += 1;
        }
        pieces.push({ canonStart: cursor, canonEnd: cursor + text.length, origStart: pair.start, origEnd: pair.end });
        params.push({
            index,
            key: pair.key,
            value: pair.value,
            hasValue: pair.hasValue,
            raw: pair.raw,
            origStart: pair.start,
            origEnd: pair.end,
            canonStart: cursor,
            canonEnd: cursor + text.length,
        });
        cursor += text.length;
        parts.push(text);
    });
    return { query: parts.join('&'), params, pieces };
}
