import { MISSING, type ProjectionRow } from "../src/project.ts";

/** Normalizes rows into plain comparable data (MISSING becomes a tagged object). */
export function normalizeRows(rows: ProjectionRow[]): unknown[] {
  return rows.map((row) =>
    Object.entries(row).map(([name, cell]) => [
      name,
      cell.path,
      cell.value === MISSING ? { tag: "missing" } : { tag: "value", value: cell.value },
    ]),
  );
}

export function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === "object") {
    for (const key of Object.keys(value as Record<string, unknown>)) {
      deepFreeze((value as Record<string, unknown>)[key]);
    }
    Object.freeze(value);
  }
  return value;
}

export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function randomInt(rng: () => number, n: number): number {
  return Math.floor(rng() * n);
}
