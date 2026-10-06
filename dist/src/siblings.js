import { VersionVector } from './version-vector.js';
/**
 * Set-merge model for sibling conflict sets:
 * take the union, dedupe by version vector, then retract every element
 * dominated by another element of the union. Concurrent versions are all
 * preserved — never resolved by wall clock or any arrival order.
 *
 * Because retraction is decided by dominance inside the merged union, a
 * version that was retracted after being superseded can never be
 * resurrected by a later merge: any set containing its dominator will
 * retract it again.
 */
export function mergeSiblings(items, evidence) {
    const byVector = new Map();
    for (const item of items) {
        const key = item.vv.toString();
        if (!byVector.has(key))
            byVector.set(key, item);
    }
    const all = [...byVector.values()];
    const kept = [];
    for (const candidate of all) {
        let dominator;
        for (const other of all) {
            if (other === candidate)
                continue;
            if (other.vv.compare(candidate.vv) === 'dominates') {
                dominator = other;
                break;
            }
        }
        if (dominator === undefined) {
            kept.push(candidate);
        }
        else {
            evidence?.push({
                relation: 'dominates',
                kept: dominator.vv.toString(),
                retracted: candidate.vv.toString(),
                detail: `${dominator.vv} dominates ${candidate.vv} -> retract ${candidate.vv}`,
            });
        }
    }
    if (evidence !== undefined) {
        for (let i = 0; i < kept.length; i++) {
            for (let j = i + 1; j < kept.length; j++) {
                const a = kept[i];
                const b = kept[j];
                evidence.push({
                    relation: 'concurrent',
                    kept: `${a.vv} || ${b.vv}`,
                    detail: `${a.vv} concurrent with ${b.vv} -> both kept in conflict set`,
                });
            }
        }
    }
    return kept;
}
/** Causal context of a conflict set: the join of all sibling vectors. */
export function contextOf(siblings) {
    let ctx = VersionVector.zero();
    for (const s of siblings)
        ctx = ctx.merge(s.vv);
    return ctx;
}
export function sameSet(a, b) {
    if (a.length !== b.length)
        return false;
    const keys = new Set(a.map((s) => s.vv.toString()));
    return b.every((s) => keys.has(s.vv.toString()));
}
