export function intervalContains(interval, keyHash) {
    const { start, end } = interval;
    if (start === end)
        return true;
    if (start < end)
        return keyHash > start && keyHash <= end;
    return keyHash > start || keyHash <= end;
}
export function planMigration(oldRing, newRing) {
    const boundaries = new Set();
    for (const point of oldRing.ownershipPoints())
        boundaries.add(point.hash);
    for (const point of newRing.ownershipPoints())
        boundaries.add(point.hash);
    const points = [...boundaries].sort((a, b) => a - b);
    if (points.length === 0)
        return [];
    const changed = [];
    for (let i = 0; i < points.length; i++) {
        const end = points[i];
        const start = i === 0 ? points[points.length - 1] : points[i - 1];
        const from = oldRing.ownerOfHash(end) ?? null;
        const to = newRing.ownerOfHash(end) ?? null;
        if (from !== to)
            changed.push({ start, end, from, to });
    }
    if (changed.length === 0)
        return [];
    const merged = [];
    for (const segment of changed) {
        const last = merged[merged.length - 1];
        if (last && last.from === segment.from && last.to === segment.to && last.end === segment.start) {
            last.end = segment.end;
        }
        else {
            merged.push({ ...segment });
        }
    }
    if (merged.length > 1) {
        const first = merged[0];
        const last = merged[merged.length - 1];
        if (first.from === last.from && first.to === last.to && last.end === first.start) {
            first.start = last.start;
            merged.pop();
        }
    }
    return merged;
}
