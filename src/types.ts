/** Half-open interval [start, end). */
export interface Interval {
  start: number;
  end: number;
}

export interface PackageSpec {
  id: string;
  /** Coverage intervals (half-open, may overlap receiver and other packages). */
  cover: Interval[];
  /** Download size in bytes; also the selection cost (counted once per package). */
  bytes: number;
  /** Staging memory occupied by this package's decode dictionary once decoded. */
  dictBytes: number;
  /** Ids of packages whose decode dictionaries must be resident to decode this one. */
  needs: string[];
}

export interface Problem {
  /** Total sync range. */
  range: Interval;
  /** Intervals the receiver already has. */
  receiver: Interval[];
  /** Staging memory limit in bytes; download+decode must never exceed it. */
  memoryLimit: number;
  /** Maximum number of selectable packages (default 20). */
  maxPackages: number;
  packages: PackageSpec[];
}

function isObj(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function num(v: unknown, what: string): number {
  if (typeof v !== "number" || !Number.isFinite(v)) throw new Error(`${what}: expected a finite number`);
  return v;
}

function nonNegInt(v: unknown, what: string): number {
  const n = num(v, what);
  if (!Number.isInteger(n) || n < 0) throw new Error(`${what}: expected a non-negative integer`);
  return n;
}

function interval(v: unknown, what: string): Interval {
  if (!isObj(v)) throw new Error(`${what}: expected an object {start,end}`);
  const start = num(v.start, `${what}.start`);
  const end = num(v.end, `${what}.end`);
  if (!(start < end)) throw new Error(`${what}: require start < end, got [${start}, ${end})`);
  return { start, end };
}

function intervalList(v: unknown, what: string): Interval[] {
  if (!Array.isArray(v)) throw new Error(`${what}: expected an array of intervals`);
  return v.map((x, i) => interval(x, `${what}[${i}]`));
}

/** Parse and validate a problem definition from raw JSON. */
export function parseProblem(raw: unknown): Problem {
  if (!isObj(raw)) throw new Error("problem: expected a JSON object");
  const range = interval(raw.range, "range");
  const receiver = intervalList(raw.receiver ?? [], "receiver");
  const memoryLimit = nonNegInt(raw.memoryLimit, "memoryLimit");
  const maxPackages = raw.maxPackages === undefined ? 20 : nonNegInt(raw.maxPackages, "maxPackages");
  if (!Array.isArray(raw.packages)) throw new Error("packages: expected an array");
  const packages: PackageSpec[] = raw.packages.map((p, i) => {
    const what = `packages[${i}]`;
    if (!isObj(p)) throw new Error(`${what}: expected an object`);
    if (typeof p.id !== "string" || p.id.length === 0) throw new Error(`${what}.id: expected a non-empty string`);
    const needs = p.needs ?? [];
    if (!Array.isArray(needs) || needs.some((x) => typeof x !== "string")) {
      throw new Error(`${what}.needs: expected an array of package ids`);
    }
    return {
      id: p.id,
      cover: intervalList(p.cover, `${what}.cover`),
      bytes: nonNegInt(p.bytes, `${what}.bytes`),
      dictBytes: nonNegInt(p.dictBytes ?? 0, `${what}.dictBytes`),
      needs: needs as string[],
    };
  });
  const ids = new Set<string>();
  for (const p of packages) {
    if (ids.has(p.id)) throw new Error(`duplicate package id: ${p.id}`);
    ids.add(p.id);
  }
  for (const p of packages) {
    for (const n of p.needs) {
      if (n === p.id) throw new Error(`package ${p.id} cannot depend on itself`);
      if (!ids.has(n)) throw new Error(`package ${p.id} needs unknown package ${n}`);
    }
  }
  return { range, receiver, memoryLimit, maxPackages, packages };
}
