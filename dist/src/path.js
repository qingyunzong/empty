import { canonicalizeComponent } from './percent.js';
/**
 * Canonicalize the path portion of a URL:
 *  1. Strict percent handling per segment (unreserved decoded, reserved kept,
 *     invalid escapes reject everything) — see canonicalizeComponent.
 *  2. Dot-segment removal on the canonical segments, so `%2e` / `%2e%2e`
 *     count as `.` / `..` exactly like their literal forms (RFC 3986 §5.2.4
 *     semantics). `..` at the root is clamped.
 *  3. Leading and trailing slashes are preserved; empty path becomes `/`.
 *
 * `pathOffset` is the absolute offset of `rawPath` inside the original URL,
 * used to build the byte-mapping pieces.
 */
export function canonicalizePath(rawPath, pathOffset, steps) {
    const hadLeadingSlash = rawPath.startsWith('/');
    let trailingSlash = rawPath.length > 1 && rawPath.endsWith('/');
    const rawSegments = [];
    let segStart = 0;
    for (let i = 0; i <= rawPath.length; i++) {
        if (i === rawPath.length || rawPath[i] === '/') {
            rawSegments.push({
                text: rawPath.slice(segStart, i),
                start: pathOffset + segStart,
                end: pathOffset + i,
            });
            segStart = i + 1;
        }
    }
    const stack = [];
    rawSegments.forEach((seg, index) => {
        const isFirst = index === 0;
        const isLast = index === rawSegments.length - 1;
        if (isFirst && hadLeadingSlash)
            return; // root marker, not a real segment
        const canon = canonicalizeComponent(seg.text, `path segment #${index} '${seg.text}'`, steps);
        if (canon === '.') {
            steps.push(`path: removed dot segment '.' (original bytes ${seg.start}..${seg.end})`);
            if (isLast)
                trailingSlash = true;
            return;
        }
        if (canon === '..') {
            const popped = stack.pop();
            steps.push(popped
                ? `path: dot segment '..' removed segment '${popped.canon}' (original bytes ${seg.start}..${seg.end})`
                : `path: dot segment '..' clamped at root (original bytes ${seg.start}..${seg.end})`);
            if (isLast)
                trailingSlash = true;
            return;
        }
        if (canon === '' && isLast)
            return; // trailing-slash marker
        stack.push({ canon, start: seg.start, end: seg.end });
    });
    let path = (hadLeadingSlash ? '/' : '') + stack.map((s) => s.canon).join('/');
    if (trailingSlash && stack.length > 0 && !path.endsWith('/'))
        path += '/';
    if (path === '')
        path = '/';
    const pieces = [];
    let cursor = 0;
    if (hadLeadingSlash) {
        pieces.push({ canonStart: 0, canonEnd: 1, origStart: pathOffset, origEnd: pathOffset });
        cursor = 1;
    }
    stack.forEach((seg, index) => {
        if (index > 0) {
            pieces.push({ canonStart: cursor, canonEnd: cursor + 1, origStart: seg.start, origEnd: seg.start });
            cursor += 1;
        }
        pieces.push({
            canonStart: cursor,
            canonEnd: cursor + seg.canon.length,
            origStart: seg.start,
            origEnd: seg.end,
        });
        cursor += seg.canon.length;
    });
    if (cursor < path.length) {
        // trailing slash (generated or preserved)
        pieces.push({
            canonStart: cursor,
            canonEnd: path.length,
            origStart: pathOffset + rawPath.length,
            origEnd: pathOffset + rawPath.length,
        });
    }
    return { path, pieces };
}
