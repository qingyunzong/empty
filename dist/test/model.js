/** Independent reimplementation of strict happens-after. */
function strictlyAfter(a, b) {
    let greater = false;
    const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
    for (const key of keys) {
        const av = a[key] ?? 0;
        const bv = b[key] ?? 0;
        if (av < bv)
            return false;
        if (av > bv)
            greater = true;
    }
    return greater;
}
function maximal(ops) {
    return ops.filter((op) => !ops.some((other) => other.id !== op.id && strictlyAfter(other.clock, op.clock)));
}
export function modelEffective(allOps) {
    const perms = [...new Set(allOps.map((op) => op.perm))].sort();
    const out = new Map();
    for (const perm of perms) {
        const grants = allOps.filter((op) => op.perm === perm && op.kind === 'grant');
        const revokes = allOps.filter((op) => op.perm === perm && op.kind === 'revoke');
        const surviving = grants.filter((g) => revokes.every((r) => strictlyAfter(g.clock, r.clock)));
        const granted = surviving.length > 0;
        out.set(perm, {
            granted,
            sources: granted ? maximal(surviving).map((op) => op.id).sort() : [],
            revokedBy: granted ? [] : maximal(revokes).map((op) => op.id).sort(),
        });
    }
    return out;
}
