/**
 * An independent route matcher, deliberately implemented apart from the
 * canonicalizer (its own percent-decoding and dot-segment handling), so it
 * can be used to cross-check that canonical key equivalence does not change
 * public route semantics.
 */
function isHex(ch) {
    return ch !== undefined && /[0-9A-Fa-f]/.test(ch);
}
function pushUtf8(bytes, cp) {
    if (cp < 0x80)
        bytes.push(cp);
    else if (cp < 0x800)
        bytes.push(0xc0 | (cp >> 6), 0x80 | (cp & 0x3f));
    else if (cp < 0x10000)
        bytes.push(0xe0 | (cp >> 12), 0x80 | ((cp >> 6) & 0x3f), 0x80 | (cp & 0x3f));
    else
        bytes.push(0xf0 | (cp >> 18), 0x80 | ((cp >> 12) & 0x3f), 0x80 | ((cp >> 6) & 0x3f), 0x80 | (cp & 0x3f));
}
function decodeUtf8(bytes) {
    let out = '';
    for (let i = 0; i < bytes.length; i++) {
        const b0 = bytes[i];
        if (b0 < 0x80) {
            out += String.fromCodePoint(b0);
        }
        else if (b0 < 0xe0 && i + 1 < bytes.length) {
            out += String.fromCodePoint(((b0 & 0x1f) << 6) | (bytes[++i] & 0x3f));
        }
        else if (b0 < 0xf0 && i + 2 < bytes.length) {
            out += String.fromCodePoint(((b0 & 0x0f) << 12) | ((bytes[++i] & 0x3f) << 6) | (bytes[++i] & 0x3f));
        }
        else if (b0 >= 0xf0 && i + 3 < bytes.length) {
            out += String.fromCodePoint(((b0 & 0x07) << 18) |
                ((bytes[++i] & 0x3f) << 12) |
                ((bytes[++i] & 0x3f) << 6) |
                (bytes[++i] & 0x3f));
        }
        else {
            out += '�';
        }
    }
    return out;
}
/** Full percent-decoding (all bytes, UTF-8); invalid escapes pass through. */
export function decodeSegmentFully(segment) {
    const bytes = [];
    for (let i = 0; i < segment.length; i++) {
        const ch = segment[i];
        if (ch === '%' && isHex(segment[i + 1]) && isHex(segment[i + 2])) {
            bytes.push(parseInt(segment.slice(i + 1, i + 3), 16));
            i += 2;
        }
        else {
            const cp = segment.codePointAt(i);
            if (cp > 0xffff)
                i++;
            pushUtf8(bytes, cp);
        }
    }
    return decodeUtf8(bytes);
}
/** Independent dot-segment resolution on fully decoded segments. */
function resolveSegments(rawPath) {
    const out = [];
    const parts = rawPath.split('/');
    parts.forEach((part, index) => {
        const decoded = decodeSegmentFully(part);
        if (index > 0 && decoded === '.')
            return;
        if (index > 0 && decoded === '..') {
            if (out.length > 1)
                out.pop();
            return;
        }
        out.push(decoded);
    });
    return out;
}
/** Match a raw (not necessarily canonical) path against the route table. */
export function matchRoute(routes, rawPath) {
    const segments = resolveSegments(rawPath);
    for (const route of routes) {
        const patternSegs = route.pattern.split('/');
        if (patternSegs.length !== segments.length)
            continue;
        const params = {};
        let ok = true;
        for (let i = 0; i < patternSegs.length; i++) {
            const pat = patternSegs[i];
            const seg = segments[i];
            if (pat.startsWith('{') && pat.endsWith('}')) {
                params[pat.slice(1, -1)] = seg;
            }
            else if (pat !== seg) {
                ok = false;
                break;
            }
        }
        if (ok)
            return { name: route.name, params };
    }
    return null;
}
