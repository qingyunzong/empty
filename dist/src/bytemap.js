import { CanonicalizationError } from './percent.js';
function clamp(value, lo, hi) {
    return value < lo ? lo : value > hi ? hi : value;
}
/**
 * Bidirectional offset mapping between the canonical byte string and the
 * original URL string. Offsets inside a piece are interpolated linearly and
 * clamped; offsets in removed regions snap to the nearest surviving piece.
 */
export class ByteMap {
    canonicalLength;
    originalLength;
    pieces;
    constructor(pieces, canonicalLength, originalLength) {
        this.pieces = pieces;
        this.canonicalLength = canonicalLength;
        this.originalLength = originalLength;
    }
    canonicalToOriginal(canonOffset) {
        const target = clamp(canonOffset, 0, this.canonicalLength);
        let best;
        let bestDist = Infinity;
        for (const piece of this.pieces) {
            let dist;
            if (target < piece.canonStart)
                dist = piece.canonStart - target;
            else if (target > piece.canonEnd)
                dist = target - piece.canonEnd;
            else
                dist = 0;
            // On ties prefer the wider (more source-backed) piece so boundaries
            // resolve to real content rather than generated separators.
            if (dist < bestDist ||
                (dist === bestDist && best !== undefined &&
                    piece.canonEnd - piece.canonStart > best.canonEnd - best.canonStart)) {
                bestDist = dist;
                best = piece;
            }
        }
        if (!best)
            return 0;
        const span = best.canonEnd - best.canonStart;
        if (span === 0)
            return best.origStart;
        const ratio = (clamp(target, best.canonStart, best.canonEnd) - best.canonStart) / span;
        return Math.round(best.origStart + ratio * (best.origEnd - best.origStart));
    }
    originalToCanonical(origOffset) {
        const target = clamp(origOffset, 0, this.originalLength);
        let best;
        let bestDist = Infinity;
        for (const piece of this.pieces) {
            let dist;
            if (target < piece.origStart)
                dist = piece.origStart - target;
            else if (target > piece.origEnd)
                dist = target - piece.origEnd;
            else
                dist = 0;
            if (dist < bestDist ||
                (dist === bestDist && best !== undefined &&
                    piece.origEnd - piece.origStart > best.origEnd - best.origStart)) {
                bestDist = dist;
                best = piece;
            }
        }
        if (!best)
            return 0;
        const span = best.origEnd - best.origStart;
        if (span === 0)
            return best.canonStart;
        const ratio = (clamp(target, best.origStart, best.origEnd) - best.origStart) / span;
        return Math.round(best.canonStart + ratio * (best.canonEnd - best.canonStart));
    }
}
/**
 * Apply several edits to the original URL atomically: every interval is
 * validated (in range, non-overlapping) before anything is built, so an
 * invalid edit set throws and leaves the original untouched.
 */
export function replaceOriginalIntervals(original, edits) {
    const sorted = [...edits].sort((a, b) => a.start - b.start || a.end - b.end);
    for (const edit of sorted) {
        if (!Number.isInteger(edit.start) ||
            !Number.isInteger(edit.end) ||
            edit.start < 0 ||
            edit.end < edit.start ||
            edit.end > original.length) {
            throw new CanonicalizationError(`invalid edit interval [${edit.start}, ${edit.end}) for string of length ` +
                `${original.length} — no replacement applied`);
        }
    }
    for (let i = 1; i < sorted.length; i++) {
        const prev = sorted[i - 1];
        const cur = sorted[i];
        if (cur.start < prev.end) {
            throw new CanonicalizationError(`overlapping edits [${prev.start}, ${prev.end}) and [${cur.start}, ${cur.end}) ` +
                `— no replacement applied`);
        }
    }
    let out = '';
    let pos = 0;
    for (const edit of sorted) {
        out += original.slice(pos, edit.start) + edit.value;
        pos = edit.end;
    }
    return out + original.slice(pos);
}
