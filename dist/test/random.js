export function mulberry32(seed) {
    let a = seed >>> 0;
    return () => {
        a |= 0;
        a = (a + 0x6d2b79f5) | 0;
        let t = Math.imul(a ^ (a >>> 15), 1 | a);
        t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}
const VALUE_POOL = ['red', 'blue', 'green', 0, 1, 42, true, false, null, 'x'];
const FIELD_POOL = ['name', 'color', 'size', 'qty', 'flag', 'note', 'tag', 'rank'];
export function pick(rng, arr) {
    return arr[Math.floor(rng() * arr.length)];
}
export function randomValue(rng) {
    return pick(rng, VALUE_POOL);
}
export function randomSnapshot(rng, itemCount) {
    const items = [];
    for (let i = 0; i < itemCount; i++) {
        const fields = {};
        const fieldCount = 1 + Math.floor(rng() * 4);
        for (let f = 0; f < fieldCount; f++) {
            fields[pick(rng, FIELD_POOL)] = randomValue(rng);
        }
        items.push({ id: `item-${i + 1}`, fields });
    }
    return items;
}
export function cloneItems(items) {
    return items.map((item) => ({ id: item.id, fields: { ...item.fields } }));
}
/** Apply one random edit in place: add/remove item or add/remove/set field. */
export function randomEdit(rng, items, nextId) {
    const ops = ['add-item', 'remove-item', 'set-field', 'add-field', 'remove-field'];
    const op = pick(rng, ops);
    if (op === 'add-item' || items.length === 0) {
        const fields = {};
        const fieldCount = 1 + Math.floor(rng() * 3);
        for (let f = 0; f < fieldCount; f++)
            fields[pick(rng, FIELD_POOL)] = randomValue(rng);
        items.push({ id: `item-${nextId.value++}`, fields });
        return;
    }
    const idx = Math.floor(rng() * items.length);
    const item = items[idx];
    if (op === 'remove-item') {
        items.splice(idx, 1);
        return;
    }
    const keys = Object.keys(item.fields);
    if (op === 'remove-field' && keys.length > 0) {
        delete item.fields[pick(rng, keys)];
        return;
    }
    if (op === 'add-field') {
        item.fields[pick(rng, FIELD_POOL)] = randomValue(rng);
        return;
    }
    // set-field
    if (keys.length === 0) {
        item.fields[pick(rng, FIELD_POOL)] = randomValue(rng);
    }
    else {
        item.fields[pick(rng, keys)] = randomValue(rng);
    }
}
export function editedCopy(rng, items, editCount, nextId) {
    const copy = cloneItems(items);
    for (let i = 0; i < editCount; i++)
        randomEdit(rng, copy, nextId);
    return copy;
}
