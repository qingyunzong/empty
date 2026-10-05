/** Seeded RNG + random snapshot/edit generators for property tests. */
import type { FieldValue, Item } from '../src/sync.js';

export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const VALUE_POOL: FieldValue[] = ['red', 'blue', 'green', 0, 1, 42, true, false, null, 'x'];
const FIELD_POOL = ['name', 'color', 'size', 'qty', 'flag', 'note', 'tag', 'rank'];

export function pick<T>(rng: () => number, arr: readonly T[]): T {
  return arr[Math.floor(rng() * arr.length)]!;
}

export function randomValue(rng: () => number): FieldValue {
  return pick(rng, VALUE_POOL);
}

export function randomSnapshot(rng: () => number, itemCount: number): Item[] {
  const items: Item[] = [];
  for (let i = 0; i < itemCount; i++) {
    const fields: Record<string, FieldValue> = {};
    const fieldCount = 1 + Math.floor(rng() * 4);
    for (let f = 0; f < fieldCount; f++) {
      fields[pick(rng, FIELD_POOL)] = randomValue(rng);
    }
    items.push({ id: `item-${i + 1}`, fields });
  }
  return items;
}

export function cloneItems(items: readonly Item[]): Item[] {
  return items.map((item) => ({ id: item.id, fields: { ...item.fields } }));
}

/** Apply one random edit in place: add/remove item or add/remove/set field. */
export function randomEdit(rng: () => number, items: Item[], nextId: { value: number }): void {
  const ops = ['add-item', 'remove-item', 'set-field', 'add-field', 'remove-field'] as const;
  const op = pick(rng, ops);
  if (op === 'add-item' || items.length === 0) {
    const fields: Record<string, FieldValue> = {};
    const fieldCount = 1 + Math.floor(rng() * 3);
    for (let f = 0; f < fieldCount; f++) fields[pick(rng, FIELD_POOL)] = randomValue(rng);
    items.push({ id: `item-${nextId.value++}`, fields });
    return;
  }
  const idx = Math.floor(rng() * items.length);
  const item = items[idx]!;
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
  } else {
    item.fields[pick(rng, keys)] = randomValue(rng);
  }
}

export function editedCopy(
  rng: () => number,
  items: readonly Item[],
  editCount: number,
  nextId: { value: number },
): Item[] {
  const copy = cloneItems(items);
  for (let i = 0; i < editCount; i++) randomEdit(rng, copy, nextId);
  return copy;
}
