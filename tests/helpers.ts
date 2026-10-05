import { IGNORED_PLACEHOLDER, type JsonValue } from "../src/index.js";

/** Deterministic PRNG (mulberry32) so property tests are reproducible. */
export function makeRng(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const KEY_POOL = ["id", "name", "ts", "meta", "value", "tags", "user", "ok", "n", "deep"];
const STR_POOL = ["alpha", "beta", "", "x y", "ünïcode", "0", "null"];

export function randomJson(rng: () => number, depth = 0): JsonValue {
  const r = rng();
  if (depth >= 4 || r < 0.45) {
    const p = rng();
    if (p < 0.25) return STR_POOL[Math.floor(rng() * STR_POOL.length)]!;
    if (p < 0.55) return Math.floor(rng() * 2000) - 1000;
    if (p < 0.7) return rng() < 0.5;
    if (p < 0.8) return null;
    return Math.round(rng() * 1000) / 1000;
  }
  if (r < 0.75) {
    const obj: Record<string, JsonValue> = {};
    const n = Math.floor(rng() * 5);
    for (let i = 0; i < n; i += 1) {
      obj[KEY_POOL[Math.floor(rng() * KEY_POOL.length)]! + i] = randomJson(rng, depth + 1);
    }
    return obj;
  }
  const arr: JsonValue[] = [];
  const n = Math.floor(rng() * 5);
  for (let i = 0; i < n; i += 1) arr.push(randomJson(rng, depth + 1));
  return arr;
}

type Seg = string | number;

/** Collects every path in a JSON value (intermediate nodes included). */
export function collectPaths(value: JsonValue, base: Seg[] = [], out: Seg[][] = []): Seg[][] {
  out.push(base);
  if (Array.isArray(value)) {
    value.forEach((item, i) => collectPaths(item, [...base, i], out));
  } else if (typeof value === "object" && value !== null) {
    for (const key of Object.keys(value)) {
      collectPaths((value as Record<string, JsonValue>)[key]!, [...base, key], out);
    }
  }
  return out;
}

function segToRule(seg: Seg): string {
  return typeof seg === "number" ? `[${seg}]` : /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(seg) ? `.${seg}` : `[${JSON.stringify(seg)}]`;
}

/** Builds random ignore rules from real paths of `value`, plus some bogus ones. */
export function randomRules(rng: () => number, value: JsonValue): string[] {
  const paths = collectPaths(value).filter((p) => p.length > 0);
  const rules: string[] = [];
  const count = Math.floor(rng() * 4);
  for (let i = 0; i < count && paths.length > 0; i += 1) {
    const p = paths[Math.floor(rng() * paths.length)]!;
    const segs = p.map((s) => (rng() < 0.25 ? "*" : s));
    rules.push(segs.map(segToRule).join("").replace(/^\./, ""));
  }
  if (rng() < 0.4) rules.push("no.such.path");
  return [...new Set(rules)];
}

/** Applies 0..3 random structural/value mutations to a deep copy of `value`. */
export function mutate(rng: () => number, value: JsonValue): JsonValue {
  const copy = structuredClone(value);
  const times = Math.floor(rng() * 4);
  for (let i = 0; i < times; i += 1) {
    const paths = collectPaths(copy).filter((p) => p.length > 0);
    if (paths.length === 0) break;
    const path = paths[Math.floor(rng() * paths.length)]!;
    const parentPath = path.slice(0, -1);
    const last = path[path.length - 1]!;
    let parent: JsonValue = copy;
    for (const seg of parentPath) {
      parent = Array.isArray(parent)
        ? parent[seg as number]!
        : (parent as Record<string, JsonValue>)[seg as string]!;
    }
    const kind = Math.floor(rng() * 6);
    if (Array.isArray(parent) && typeof last === "number") {
      if (kind === 0 && parent.length > 1) parent.splice(last, 1);
      else if (kind === 1) parent.splice(last, 0, randomJson(rng, 3));
      else if (kind === 2 && parent.length > 1) {
        const j = Math.floor(rng() * parent.length);
        [parent[last], parent[j]] = [parent[j]!, parent[last]!];
      } else parent[last] = randomJson(rng, 3);
    } else if (!Array.isArray(parent) && parent !== null && typeof parent === "object") {
      const rec = parent as Record<string, JsonValue>;
      if (kind === 0) delete rec[last as string];
      else if (kind === 1) rec["extra" + Math.floor(rng() * 100)] = randomJson(rng, 3);
      else rec[last as string] = randomJson(rng, 3);
    }
  }
  return copy;
}

/**
 * Independent recursive deep-equal, written separately from the library's
 * comparator on purpose: property tests cross-check the library against it.
 */
export function deepEqualIndependent(a: unknown, b: unknown): boolean {
  if (Object.is(a, b)) return true;
  if (typeof a !== "object" || typeof b !== "object" || a === null || b === null) return false;
  const aArr = Array.isArray(a);
  if (aArr !== Array.isArray(b)) return false;
  if (aArr && Array.isArray(b)) {
    if (a.length !== b.length) return false;
    for (let i = 0; i < a.length; i += 1) {
      if (!deepEqualIndependent(a[i], b[i])) return false;
    }
    return true;
  }
  const aKeys = Object.keys(a);
  const bKeys = Object.keys(b);
  if (aKeys.length !== bKeys.length) return false;
  for (const key of aKeys) {
    if (!Object.prototype.hasOwnProperty.call(b, key)) return false;
    if (!deepEqualIndependent((a as Record<string, unknown>)[key], (b as Record<string, unknown>)[key])) {
      return false;
    }
  }
  return true;
}

/** Random JSON never contains the placeholder; guard the assumption. */
export function containsPlaceholder(value: unknown): boolean {
  return JSON.stringify(value).includes(IGNORED_PLACEHOLDER);
}
