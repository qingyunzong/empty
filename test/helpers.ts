import type { JsonValue } from "../src/snapshot.js";
import { parsePath } from "../src/snapshot.js";

/** Deterministic PRNG (mulberry32) so test runs are reproducible. */
export function mulberry32(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function randomInt(rng: () => number, lo: number, hi: number): number {
  return lo + Math.floor(rng() * (hi - lo + 1));
}

export function pick<T>(rng: () => number, arr: readonly T[]): T {
  return arr[Math.floor(rng() * arr.length)];
}

const KEY_POOL = [
  "id", "name", "value", "meta", "items", "count", "flag", "data",
  "createdAt", "updatedAt", "nested", "x", "y", "0", "weird key", "a.b",
];

export function randomJson(rng: () => number, depth = 0): JsonValue {
  const r = rng();
  if (depth >= 4 || r < 0.35) {
    return pick(rng, [
      null, true, false,
      randomInt(rng, -1000, 1000),
      Math.round(rng() * 1000) / 100,
      pick(rng, ["", "foo", "bar", "hello world", "__snapshot_ignored__", "__snapshot_ignored__number", "0"]),
    ] as const);
  }
  if (r < 0.68) {
    const len = randomInt(rng, 0, 4);
    const arr: JsonValue[] = [];
    for (let i = 0; i < len; i++) arr.push(randomJson(rng, depth + 1));
    return arr;
  }
  const keys = new Set<string>();
  const n = randomInt(rng, 0, 4);
  while (keys.size < n) keys.add(pick(rng, KEY_POOL));
  const obj: Record<string, JsonValue> = {};
  for (const k of keys) obj[k] = randomJson(rng, depth + 1);
  return obj;
}

/**
 * Independent recursive deep equality, written separately from the library
 * implementation on purpose, to cross-check `diff` and `normalize`.
 */
export function independentEqual(x: unknown, y: unknown): boolean {
  if (Object.is(x, y)) return true;
  if (x === null || y === null) return false;
  if (typeof x !== typeof y) return false;
  const xArr = Array.isArray(x);
  const yArr = Array.isArray(y);
  if (xArr || yArr) {
    if (!xArr || !yArr) return false;
    if (x.length !== (y as unknown[]).length) return false;
    for (let i = 0; i < x.length; i++) {
      if (!independentEqual(x[i], (y as unknown[])[i])) return false;
    }
    return true;
  }
  if (typeof x === "object") {
    const xo = x as Record<string, unknown>;
    const yo = y as Record<string, unknown>;
    const xk = Object.keys(xo);
    const yk = Object.keys(yo);
    if (xk.length !== yk.length) return false;
    for (const k of xk) {
      if (!Object.prototype.hasOwnProperty.call(yo, k)) return false;
      if (!independentEqual(xo[k], yo[k])) return false;
    }
    return true;
  }
  return false;
}

/** Collect every path (root included) of a JSON value. */
export function collectPaths(v: JsonValue, base: (string | number)[] = []): (string | number)[][] {
  const out: (string | number)[][] = [base];
  if (Array.isArray(v)) {
    v.forEach((el, i) => out.push(...collectPaths(el, [...base, i])));
  } else if (typeof v === "object" && v !== null) {
    for (const k of Object.keys(v)) out.push(...collectPaths(v[k], [...base, k]));
  }
  return out;
}

export function getAtPath(v: JsonValue, pathRule: string): { found: boolean; value: unknown } {
  const segments = parsePath(pathRule);
  let cur: unknown = v;
  for (const seg of segments) {
    if (typeof seg === "number") {
      if (!Array.isArray(cur) || seg >= cur.length) return { found: false, value: undefined };
      cur = cur[seg];
    } else {
      if (typeof cur !== "object" || cur === null || Array.isArray(cur)) {
        return { found: false, value: undefined };
      }
      if (!Object.prototype.hasOwnProperty.call(cur, seg)) return { found: false, value: undefined };
      cur = (cur as Record<string, unknown>)[seg];
    }
  }
  return { found: true, value: cur };
}

function setAtPath(v: JsonValue, path: (string | number)[], next: JsonValue | undefined, deleteLeaf: boolean): JsonValue {
  if (path.length === 0) return deleteLeaf ? v : (next as JsonValue);
  const [head, ...rest] = path;
  if (typeof head === "number") {
    const arr = (Array.isArray(v) ? v : []).slice();
    if (deleteLeaf && rest.length === 0) {
      arr.splice(head, 1);
    } else {
      arr[head] = setAtPath(arr[head] ?? null, rest, next, deleteLeaf);
    }
    return arr;
  }
  const obj: Record<string, JsonValue> = { ...(typeof v === "object" && v !== null && !Array.isArray(v) ? v : {}) };
  if (deleteLeaf && rest.length === 0) {
    delete obj[head];
  } else {
    obj[head] = setAtPath(obj[head] ?? null, rest, next, deleteLeaf);
  }
  return obj;
}

function shuffle<T>(rng: () => number, arr: T[]): T[] {
  const out = arr.slice();
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

/** Apply one random mutation; may also be a no-op (key reorder). */
export function mutate(rng: () => number, v: JsonValue): JsonValue {
  const paths = collectPaths(v).filter((p) => p.length > 0);
  if (paths.length === 0) return randomJson(rng);
  const path = pick(rng, paths);
  const kind = randomInt(rng, 0, 5);
  switch (kind) {
    case 0: // replace subtree with a fresh random value
      return setAtPath(v, path, randomJson(rng), false);
    case 1: // delete the node (key or array element)
      return setAtPath(v, path, undefined, true);
    case 2: { // tweak numbers / flip booleans / change strings
      const cur = getAtPath(v, pathToRule(path)).value;
      let next: JsonValue;
      if (typeof cur === "number") next = cur + pick(rng, [1, -1, 0.5] as const);
      else if (typeof cur === "boolean") next = !cur;
      else if (typeof cur === "string") next = cur + "!";
      else next = randomJson(rng);
      return setAtPath(v, path, next, false);
    }
    case 3: { // reorder object keys at path (semantically a no-op)
      const cur = getAtPath(v, pathToRule(path)).value;
      if (typeof cur !== "object" || cur === null || Array.isArray(cur)) return v;
      const reordered: Record<string, JsonValue> = {};
      for (const k of shuffle(rng, Object.keys(cur))) reordered[k] = (cur as Record<string, JsonValue>)[k];
      return setAtPath(v, path, reordered, false);
    }
    case 4: { // shuffle array at path (order change)
      const cur = getAtPath(v, pathToRule(path)).value;
      if (!Array.isArray(cur) || cur.length < 2) return v;
      return setAtPath(v, path, shuffle(rng, cur), false);
    }
    default: { // add an extra key/element near the path
      const parent = path.slice(0, -1);
      const cur = getAtPath(v, pathToRule(parent)).value;
      if (Array.isArray(cur)) {
        return setAtPath(v, parent, [...cur, randomJson(rng)], false);
      }
      if (typeof cur === "object" && cur !== null) {
        return setAtPath(v, parent, { ...(cur as Record<string, JsonValue>), extra: randomJson(rng) }, false);
      }
      return setAtPath(v, path, randomJson(rng), false);
    }
  }
}

function pathToRule(path: (string | number)[]): string {
  let out = "$";
  for (const seg of path) {
    if (typeof seg === "number") out += `[${seg}]`;
    else if (/^[A-Za-z_$][A-Za-z0-9_$]*$/.test(seg)) out += `.${seg}`;
    else out += `[${JSON.stringify(seg)}]`;
  }
  return out;
}

/** Build random ignore rules from existing paths plus wildcards and misses. */
export function randomRules(rng: () => number, v: JsonValue, count: number): string[] {
  const paths = collectPaths(v);
  const rules: string[] = [];
  for (let i = 0; i < count; i++) {
    const path = pick(rng, paths);
    let rule = "$";
    for (const seg of path) {
      if (rng() < 0.25) {
        rule += typeof seg === "number" ? "[*]" : ".*";
      } else if (typeof seg === "number") {
        rule += `[${seg}]`;
      } else if (/^[A-Za-z_$][A-Za-z0-9_$]*$/.test(seg)) {
        rule += `.${seg}`;
      } else {
        rule += `[${JSON.stringify(seg)}]`;
      }
    }
    rules.push(rule);
  }
  // Occasionally add a rule that matches nothing.
  if (rng() < 0.3) rules.push("$.nonexistent.deep[9]");
  return rules;
}
