/** Input model and validation. All intervals are inclusive integer ranges. */

export interface Pkg {
  id: string;
  coverL: number;
  coverR: number;
  /** Download size in bytes; paid at most once even if coverage overlaps. */
  bytes: number;
  /** Decode dictionary size; occupies scratch memory from decode until release. */
  dict: number;
  /** Ids of packages whose decode dictionaries must be resident while decoding this one. */
  deps: string[];
}

export interface PlanInput {
  existing: Array<[number, number]>;
  packages: Pkg[];
  maxPackages: number;
  memoryLimit: number | null;
}

function isInt(x: unknown): x is number {
  return typeof x === "number" && Number.isInteger(x);
}

function asInterval(x: unknown, what: string): [number, number] {
  if (!Array.isArray(x) || x.length !== 2 || !isInt(x[0]) || !isInt(x[1])) {
    throw new Error(`${what} must be a [start, end] pair of integers`);
  }
  if (x[0] > x[1]) throw new Error(`${what} has start > end`);
  return [x[0], x[1]];
}

export function parseInput(raw: unknown): PlanInput {
  if (typeof raw !== "object" || raw === null) throw new Error("input must be a JSON object");
  const o = raw as Record<string, unknown>;

  if (!Array.isArray(o.existing)) throw new Error("input.existing must be an array of intervals");
  const existing = o.existing.map((iv, i) => asInterval(iv, `existing[${i}]`));

  if (!Array.isArray(o.packages) || o.packages.length === 0) {
    throw new Error("input.packages must be a non-empty array");
  }
  const packages: Pkg[] = o.packages.map((p, i) => {
    if (typeof p !== "object" || p === null) throw new Error(`packages[${i}] must be an object`);
    const q = p as Record<string, unknown>;
    if (typeof q.id !== "string" || q.id.length === 0) throw new Error(`packages[${i}].id must be a non-empty string`);
    const cover = asInterval(q.cover, `packages[${i}].cover`);
    if (!isInt(q.bytes) || q.bytes < 0) throw new Error(`packages[${i}].bytes must be an integer >= 0`);
    if (!isInt(q.dict) || q.dict < 0) throw new Error(`packages[${i}].dict must be an integer >= 0`);
    let deps: string[] = [];
    if (q.deps !== undefined) {
      if (!Array.isArray(q.deps) || q.deps.some((d) => typeof d !== "string")) {
        throw new Error(`packages[${i}].deps must be an array of package ids`);
      }
      deps = q.deps as string[];
    }
    return { id: q.id, coverL: cover[0], coverR: cover[1], bytes: q.bytes, dict: q.dict, deps };
  });

  const seen = new Set<string>();
  for (const p of packages) {
    if (seen.has(p.id)) throw new Error(`duplicate package id: ${p.id}`);
    seen.add(p.id);
  }
  for (const p of packages) {
    for (const d of p.deps) {
      if (!seen.has(d)) throw new Error(`package ${p.id} depends on unknown package ${d}`);
      if (d === p.id) throw new Error(`package ${p.id} depends on itself`);
    }
  }

  let maxPackages = 20;
  if (o.maxPackages !== undefined) {
    if (!isInt(o.maxPackages) || o.maxPackages < 1) throw new Error("maxPackages must be an integer >= 1");
    maxPackages = o.maxPackages;
  }

  let memoryLimit: number | null = null;
  if (o.memoryLimit !== undefined) {
    if (!isInt(o.memoryLimit) || o.memoryLimit < 0) throw new Error("memoryLimit must be an integer >= 0");
    memoryLimit = o.memoryLimit;
  }

  return { existing, packages, maxPackages, memoryLimit };
}
