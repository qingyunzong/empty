/** Seeded RNG + random snapshot/edit generators for property tests. */
import type { FieldValue, Item } from '../src/sync.js';
export declare function mulberry32(seed: number): () => number;
export declare function pick<T>(rng: () => number, arr: readonly T[]): T;
export declare function randomValue(rng: () => number): FieldValue;
export declare function randomSnapshot(rng: () => number, itemCount: number): Item[];
export declare function cloneItems(items: readonly Item[]): Item[];
/** Apply one random edit in place: add/remove item or add/remove/set field. */
export declare function randomEdit(rng: () => number, items: Item[], nextId: {
    value: number;
}): void;
export declare function editedCopy(rng: () => number, items: readonly Item[], editCount: number, nextId: {
    value: number;
}): Item[];
