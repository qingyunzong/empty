/**
 * Independent reference model used to cross-check the fixture library:
 * a plain memoized deep clone plus a canonical signature that captures
 * structure, alias topology and cycles.
 */

type AnyObj = Record<string, unknown> | unknown[];

/** Deep clone preserving shared references and cycles (memoized by identity). */
export function referenceDeepClone<T>(root: T): T {
  const memo = new Map<object, unknown>();
  const clone = (value: unknown): unknown => {
    if (value === null || typeof value !== "object") return value;
    if (memo.has(value as object)) return memo.get(value as object);
    if (Array.isArray(value)) {
      const arr: unknown[] = [];
      memo.set(value, arr);
      for (const item of value) arr.push(clone(item));
      return arr;
    }
    const obj: Record<string, unknown> = {};
    memo.set(value as object, obj);
    for (const key of Object.keys(value as AnyObj)) {
      obj[key] = clone((value as Record<string, unknown>)[key]);
    }
    return obj;
  };
  return clone(root) as T;
}

/**
 * Canonical serialization of an object graph. Each distinct object is numbered
 * in first-visit (DFS, sorted keys) order; references are emitted as `#n`, so
 * two graphs have equal signatures iff they are structurally identical AND
 * have the same aliasing/cycle topology.
 */
export function signature(root: unknown): string {
  const ids = new Map<object, number>();
  let next = 0;
  const render = (value: unknown): string => {
    if (value === null) return "null";
    const t = typeof value;
    if (t === "string") return JSON.stringify(value);
    if (t === "number" || t === "boolean") return String(value);
    if (t !== "object") throw new TypeError(`unsupported: ${t}`);
    const known = ids.get(value as object);
    if (known !== undefined) return `#${known}`;
    const id = next++;
    ids.set(value as object, id);
    if (Array.isArray(value)) {
      return `@${id}[${value.map(render).join(",")}]`;
    }
    const rec = value as Record<string, unknown>;
    const body = Object.keys(rec)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${render(rec[k])}`)
      .join(",");
    return `@${id}{${body}}`;
  };
  return render(root);
}

/**
 * Deterministic breadth-first listing of every object in a graph
 * (sorted keys), used to apply identical mutation scripts to two
 * structurally equal graphs.
 */
export function collectObjects(root: unknown): object[] {
  const seen = new Set<object>();
  const out: object[] = [];
  const queue: object[] = [root as object];
  while (queue.length > 0) {
    const obj = queue.shift() as object;
    if (obj === null || typeof obj !== "object" || seen.has(obj)) continue;
    seen.add(obj);
    out.push(obj);
    if (Array.isArray(obj)) {
      for (const item of obj) {
        if (item !== null && typeof item === "object") queue.push(item);
      }
    } else {
      for (const key of Object.keys(obj).sort()) {
        const v = (obj as Record<string, unknown>)[key];
        if (v !== null && typeof v === "object") queue.push(v);
      }
    }
  }
  return out;
}
