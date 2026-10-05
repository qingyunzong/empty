function cloneItems(items) {
    return JSON.parse(JSON.stringify(items));
}
function sortSnapshot(items) {
    const copy = cloneItems(items);
    for (const item of copy) {
        const sorted = {};
        for (const key of Object.keys(item.fields).sort())
            sorted[key] = item.fields[key];
        item.fields = sorted;
    }
    copy.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
    return copy;
}
function sameSnapshot(a, b) {
    return JSON.stringify(sortSnapshot(a)) === JSON.stringify(sortSnapshot(b));
}
function indexById(items) {
    const out = {};
    for (const item of items)
        out[item.id] = { ...item.fields };
    return out;
}
function sameFields(a, b) {
    if (a === undefined || b === undefined)
        return a === b;
    const ka = Object.keys(a);
    const kb = Object.keys(b);
    if (ka.length !== kb.length)
        return false;
    return ka.every((k) => Object.prototype.hasOwnProperty.call(b, k) && Object.is(a[k], b[k]));
}
function valEq(a, b) {
    if (a === undefined || b === undefined)
        return a === b;
    return Object.is(a, b);
}
export function oracleSync(base, source, target, merge, directives) {
    // Fast path: target untouched -> source applies wholesale.
    if (sameSnapshot(base, target)) {
        const baseIdx = indexById(base);
        const srcIdx = indexById(source);
        const ids = [...new Set([...Object.keys(baseIdx), ...Object.keys(srcIdx)])];
        const items = ids.map((id) => {
            const b = baseIdx[id];
            const s = srcIdx[id];
            let action;
            if (b && !s)
                action = 'removed';
            else if (!b && s)
                action = 'added';
            else if (!sameFields(b, s))
                action = 'updated';
            else
                action = 'unchanged';
            return { id, action, fields: [], conflicts: [], itemConflict: null };
        });
        return {
            batchStatus: 'applied',
            targetChanged: false,
            items,
            unresolved: [],
            unresolvedItems: [],
            result: cloneItems(source),
        };
    }
    const baseIdx = indexById(base);
    const srcIdx = indexById(source);
    const tgtIdx = indexById(target);
    const ids = [
        ...new Set([...Object.keys(baseIdx), ...Object.keys(srcIdx), ...Object.keys(tgtIdx)]),
    ];
    const items = [];
    const unresolved = [];
    const unresolvedItems = [];
    const mergedOut = [];
    let blocked = false;
    for (const id of ids) {
        const b = baseIdx[id];
        const s = srcIdx[id];
        const t = tgtIdx[id];
        // Item-level delete-vs-modify.
        let itemConflict = null;
        if (b && !s && t && !sameFields(b, t)) {
            itemConflict = { itemId: id, kind: 'delete-vs-modify', deletedBy: 'source' };
        }
        else if (b && s && !t && !sameFields(b, s)) {
            itemConflict = { itemId: id, kind: 'delete-vs-modify', deletedBy: 'target' };
        }
        if (itemConflict && merge) {
            const pick = directives.items?.[id];
            if (pick === 'source' || pick === 'target') {
                const kept = pick === 'source' ? s : t;
                items.push({
                    id,
                    action: kept ? 'merged' : 'removed',
                    fields: [],
                    conflicts: [],
                    itemConflict: null,
                });
                if (kept)
                    mergedOut.push({ id, fields: { ...kept } });
                itemConflict = null;
                continue;
            }
        }
        if (itemConflict) {
            unresolvedItems.push(itemConflict);
            blocked = true;
            items.push({ id, action: 'conflict', fields: [], conflicts: [], itemConflict });
            continue;
        }
        // Presence three-way.
        let present;
        if (!!s === !!b)
            present = !!t;
        else if (!!t === !!b)
            present = !!s;
        else
            present = !!s;
        const conflicts = [];
        const mergedFields = {};
        if (present) {
            const keys = new Set([
                ...Object.keys(b ?? {}),
                ...Object.keys(s ?? {}),
                ...Object.keys(t ?? {}),
            ]);
            for (const key of keys) {
                const bv = b?.[key];
                const sv = s?.[key];
                const tv = t?.[key];
                const bHas = b !== undefined && Object.prototype.hasOwnProperty.call(b, key);
                const sHas = s !== undefined && Object.prototype.hasOwnProperty.call(s, key);
                const tHas = t !== undefined && Object.prototype.hasOwnProperty.call(t, key);
                const bVal = bHas ? bv : undefined;
                const sVal = sHas ? sv : undefined;
                const tVal = tHas ? tv : undefined;
                if (valEq(sVal, bVal) && valEq(tVal, bVal)) {
                    if (bVal !== undefined)
                        mergedFields[key] = bVal;
                }
                else if (valEq(sVal, bVal)) {
                    if (tVal !== undefined)
                        mergedFields[key] = tVal;
                }
                else if (valEq(tVal, bVal)) {
                    if (sVal !== undefined)
                        mergedFields[key] = sVal;
                }
                else if (valEq(sVal, tVal)) {
                    if (sVal !== undefined)
                        mergedFields[key] = sVal;
                }
                else {
                    const directive = merge ? directives.fields?.[id]?.[key] : undefined;
                    if (directive) {
                        const value = 'value' in directive ? directive.value
                            : directive.pick === 'source' ? sVal
                                : directive.pick === 'target' ? tVal
                                    : bVal;
                        if (value !== undefined)
                            mergedFields[key] = value;
                    }
                    else {
                        conflicts.push({ itemId: id, field: key, base: bVal, source: sVal, target: tVal });
                    }
                }
            }
        }
        if (conflicts.length > 0) {
            blocked = true;
            unresolved.push(...conflicts);
            items.push({ id, action: 'conflict', fields: [], conflicts, itemConflict: null });
            continue;
        }
        let action;
        if (!present && b)
            action = 'removed';
        else if (present && !b)
            action = 'added';
        else if (present && sameFields(mergedFields, b))
            action = 'unchanged';
        else
            action = 'merged';
        items.push({ id, action, fields: [], conflicts: [], itemConflict: null });
        if (present)
            mergedOut.push({ id, fields: mergedFields });
    }
    if (!merge || blocked) {
        return {
            batchStatus: 'conflict',
            targetChanged: true,
            items,
            unresolved,
            unresolvedItems,
            result: null,
        };
    }
    return {
        batchStatus: 'merged',
        targetChanged: true,
        items,
        unresolved: [],
        unresolvedItems: [],
        result: mergedOut,
    };
}
