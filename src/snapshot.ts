/**
 * snapshot-diff: snapshot comparison with public path-based ignore rules.
 *
 * Semantics:
 * - Ignore rules use a public JSONPath-like syntax: `$.a.b[0].c`, `$.a[*].id`,
 *   `$.a.*.id`, `$.a["weird key"]`. `$` alone targets the root.
 * - Array order is significant by default; `ignoreArrayOrder: true` opts out.
 * - An ignore rule never masks structural errors: missing keys, array length
 *   changes and JSON type-tag changes are always reported, even on ignored
 *   paths. Ignoring a container still verifies its shape (keys, lengths,
 *   tags) and only suppresses value differences inside it.
 * - `diff` reports minimal difference paths: the shallowest node at which a
 *   difference is detected, carrying both sides' original values.
 * - `normalize` replaces ignored leaf values with a typed marker while keeping
 *   structure intact, and is idempotent: normalize(normalize(x)) === normalize(x).
 *   Strings starting with the reserved prefix `__snapshot_ignored__:` are
 *   reserved for markers and must not appear in snapshot data.
 */

export type JsonValue =
  | null
  | boolean
  | number
  | string
  | JsonValue[]
  | { [key: string]: JsonValue };

export type PathSegment = string | number | "*";

export type DiffKind = "value" | "structural";

export interface DiffEntry {
  /** Public path of the difference, e.g. `$.meta.items[2].id`. */
  path: string;
  /** "value" for suppressed-by-rule-able value mismatches, "structural" otherwise. */
  kind: DiffKind;
  /** Original value on the expected side (`undefined` when absent). */
  expected: unknown;
  /** Original value on the actual side (`undefined` when absent). */
  actual: unknown;
}

export interface DiffOptions {
  /** Public path rules for volatile fields to ignore. */
  ignore?: readonly string[];
  /** Opt out of order-sensitive array comparison. Default: false (order kept). */
  ignoreArrayOrder?: boolean;
}

export interface NormalizeOptions {
  /** Sort arrays canonically so normalization is order-insensitive. Default: false. */
  ignoreArrayOrder?: boolean;
}

const IDENT = /^[A-Za-z_$][A-Za-z0-9_$]*/;
const IDENT_FULL = /^[A-Za-z_$][A-Za-z0-9_$]*$/;
const MARKER_PREFIX = "__snapshot_ignored__:";

/* ------------------------------ path parsing ----------------------------- */

/** Parse a public path rule such as `$.a.b[0]["x y"].c` into segments. */
export function parsePath(rule: string): PathSegment[] {
  if (typeof rule !== "string" || rule.length === 0 || rule[0] !== "$") {
    throw new Error(`Invalid path rule ${JSON.stringify(rule)}: must start with "$"`);
  }
  const segments: PathSegment[] = [];
  let i = 1;
  while (i < rule.length) {
    const ch = rule[i];
    if (ch === ".") {
      i += 1;
      if (rule[i] === "*") {
        segments.push("*");
        i += 1;
        continue;
      }
      const m = IDENT.exec(rule.slice(i));
      if (!m) {
        throw new Error(`Invalid path rule ${JSON.stringify(rule)}: bad member at index ${i}`);
      }
      segments.push(m[0]);
      i += m[0].length;
    } else if (ch === "[") {
      if (rule.startsWith("*]", i + 1)) {
        segments.push("*");
        i += 3;
        continue;
      }
      const num = /^\[(\d+)\]/.exec(rule.slice(i));
      if (num) {
        segments.push(Number(num[1]));
        i += num[0].length;
        continue;
      }
      if (rule[i + 1] === '"') {
        let j = i + 2;
        while (j < rule.length) {
          if (rule[j] === "\\") {
            j += 2;
            continue;
          }
          if (rule[j] === '"') break;
          j += 1;
        }
        if (j >= rule.length || rule[j + 1] !== "]") {
          throw new Error(`Invalid path rule ${JSON.stringify(rule)}: unterminated quoted key`);
        }
        let key: unknown;
        try {
          key = JSON.parse(rule.slice(i + 1, j + 1));
        } catch {
          throw new Error(`Invalid path rule ${JSON.stringify(rule)}: bad quoted key`);
        }
        if (typeof key !== "string") {
          throw new Error(`Invalid path rule ${JSON.stringify(rule)}: quoted key must be a string`);
        }
        segments.push(key);
        i = j + 2;
        continue;
      }
      throw new Error(`Invalid path rule ${JSON.stringify(rule)}: bad bracket segment at index ${i}`);
    } else {
      throw new Error(
        `Invalid path rule ${JSON.stringify(rule)}: unexpected ${JSON.stringify(ch)} at index ${i}`,
      );
    }
  }
  return segments;
}

/** Format concrete path segments back into the public path syntax. */
export function formatPath(segments: readonly (string | number)[]): string {
  let out = "$";
  for (const seg of segments) {
    if (typeof seg === "number") {
      out += `[${seg}]`;
    } else if (IDENT_FULL.test(seg)) {
      out += `.${seg}`;
    } else {
      out += `[${JSON.stringify(seg)}]`;
    }
  }
  return out;
}

/* ------------------------------ rule matching ---------------------------- */

function segmentMatches(rule: PathSegment, actual: string | number, indexWildcard: boolean): boolean {
  if (rule === "*") return true;
  if (typeof rule === "number") {
    if (typeof actual !== "number") return false;
    // Under ignoreArrayOrder, numeric rule segments act as wildcards.
    return indexWildcard ? true : rule === actual;
  }
  return rule === actual;
}

function matchesAny(
  rules: readonly PathSegment[][],
  path: readonly (string | number)[],
  indexWildcard: boolean,
): boolean {
  for (const segments of rules) {
    if (segments.length !== path.length) continue;
    let ok = true;
    for (let i = 0; i < segments.length; i++) {
      if (!segmentMatches(segments[i], path[i], indexWildcard)) {
        ok = false;
        break;
      }
    }
    if (ok) return true;
  }
  return false;
}

/* --------------------------------- helpers ------------------------------- */

type Tag = "null" | "boolean" | "number" | "string" | "array" | "object";

function tagOf(v: unknown): Tag {
  if (v === null) return "null";
  if (Array.isArray(v)) return "array";
  switch (typeof v) {
    case "boolean":
      return "boolean";
    case "number":
      return "number";
    case "string":
      return "string";
    default:
      return "object";
  }
}

function isObject(v: unknown): v is Record<string, JsonValue> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function isMarker(v: unknown): boolean {
  return typeof v === "string" && v.startsWith(MARKER_PREFIX);
}

/** Deterministic serialization with sorted object keys; used for array sorting. */
function canonical(v: JsonValue): string {
  if (Array.isArray(v)) return `[${v.map(canonical).join(",")}]`;
  if (isObject(v)) {
    const keys = Object.keys(v).sort();
    return `{${keys.map((k) => `${JSON.stringify(k)}:${canonical(v[k])}`).join(",")}}`;
  }
  return JSON.stringify(v) ?? "null";
}

function byCanonical(a: JsonValue, b: JsonValue): number {
  const ca = canonical(a);
  const cb = canonical(b);
  return ca < cb ? -1 : ca > cb ? 1 : 0;
}

/* ------------------------------- normalize ------------------------------- */

/**
 * Normalize a snapshot: ignored leaf values become a typed marker while the
 * structure (keys, array lengths, type tags) is preserved. Idempotent.
 */
export function normalize(
  value: JsonValue,
  ignore: readonly string[] = [],
  options: NormalizeOptions = {},
): JsonValue {
  const rules = ignore.map(parsePath);
  const unordered = options.ignoreArrayOrder ?? false;
  return normalizeAt(value, rules, [], false, unordered, unordered);
}

function normalizeAt(
  v: JsonValue,
  rules: readonly PathSegment[][],
  path: readonly (string | number)[],
  ignoredMode: boolean,
  indexWildcard: boolean,
  sortArrays: boolean,
): JsonValue {
  if (isMarker(v)) return v; // idempotency: keep existing markers untouched
  const ignored = ignoredMode || matchesAny(rules, path, indexWildcard);
  if (Array.isArray(v)) {
    const out = v.map((el, i) => normalizeAt(el, rules, [...path, i], ignored, indexWildcard, sortArrays));
    if (sortArrays) out.sort(byCanonical);
    return out;
  }
  if (isObject(v)) {
    const out: Record<string, JsonValue> = {};
    for (const k of Object.keys(v)) {
      out[k] = normalizeAt(v[k], rules, [...path, k], ignored, indexWildcard, sortArrays);
    }
    return out;
  }
  if (ignored) return `${MARKER_PREFIX}${tagOf(v)}`;
  return v;
}

/* --------------------------------- diff ---------------------------------- */

/**
 * Compare two snapshots, returning minimal difference paths with both sides'
 * original values. Empty result means the snapshots match under the rules.
 */
export function diff(expected: JsonValue, actual: JsonValue, options: DiffOptions = {}): DiffEntry[] {
  const rules = (options.ignore ?? []).map(parsePath);
  const unordered = options.ignoreArrayOrder ?? false;
  const entries: DiffEntry[] = [];
  walk(expected, actual, [], rules, unordered, false, entries);
  return entries;
}

function push(
  entries: DiffEntry[],
  path: readonly (string | number)[],
  kind: DiffKind,
  expected: unknown,
  actual: unknown,
): void {
  entries.push({ path: formatPath(path), kind, expected, actual });
}

function has(obj: Record<string, JsonValue>, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(obj, key);
}

function walk(
  e: JsonValue,
  a: JsonValue,
  path: readonly (string | number)[],
  rules: readonly PathSegment[][],
  unordered: boolean,
  ignoredMode: boolean,
  entries: DiffEntry[],
): void {
  const eTag = tagOf(e);
  const aTag = tagOf(a);
  // Type-tag changes are structural and are reported even on ignored paths.
  if (eTag !== aTag) {
    push(entries, path, "structural", e, a);
    return;
  }
  const ignored = ignoredMode || matchesAny(rules, path, unordered);
  if (eTag === "object") {
    const eo = e as Record<string, JsonValue>;
    const ao = a as Record<string, JsonValue>;
    const keys = new Set([...Object.keys(eo), ...Object.keys(ao)]);
    for (const k of keys) {
      const inE = has(eo, k);
      const inA = has(ao, k);
      // Missing keys are structural and are reported even on ignored paths.
      if (!inE || !inA) {
        push(entries, [...path, k], "structural", inE ? eo[k] : undefined, inA ? ao[k] : undefined);
        continue;
      }
      walk(eo[k], ao[k], [...path, k], rules, unordered, ignored, entries);
    }
    return;
  }
  if (eTag === "array") {
    const ea = e as JsonValue[];
    const aa = a as JsonValue[];
    if (unordered) {
      compareUnordered(ea, aa, path, rules, ignored, entries);
      return;
    }
    const n = Math.max(ea.length, aa.length);
    for (let i = 0; i < n; i++) {
      if (i >= ea.length || i >= aa.length) {
        push(entries, [...path, i], "structural", i < ea.length ? ea[i] : undefined, i < aa.length ? aa[i] : undefined);
      } else {
        walk(ea[i], aa[i], [...path, i], rules, unordered, ignored, entries);
      }
    }
    return;
  }
  if (ignored) return; // same-tag ignored leaf: value difference is suppressed
  if (!Object.is(e, a)) {
    push(entries, path, "value", e, a);
  }
}

function compareUnordered(
  ea: JsonValue[],
  aa: JsonValue[],
  path: readonly (string | number)[],
  rules: readonly PathSegment[][],
  ignored: boolean,
  entries: DiffEntry[],
): void {
  if (ea.length !== aa.length) {
    push(entries, path, "structural", ea, aa);
    return;
  }
  // Exact check: canonically sorted normalized forms must match as multisets.
  // Numeric rule segments act as wildcards under ignoreArrayOrder.
  const sortNorm = (arr: JsonValue[]): string[] =>
    arr
      .map((el) => canonical(normalizeAt(el, rules, [...path, 0], ignored, true, true)))
      .sort();
  const ne = sortNorm(ea);
  const na = sortNorm(aa);
  let equal = true;
  for (let i = 0; i < ne.length; i++) {
    if (ne[i] !== na[i]) {
      equal = false;
      break;
    }
  }
  if (equal) return;
  // Greedy pairing, only to produce readable entries for the mismatch.
  const used = new Array<boolean>(aa.length).fill(false);
  for (let i = 0; i < ea.length; i++) {
    let found = -1;
    for (let j = 0; j < aa.length; j++) {
      if (used[j]) continue;
      const probe: DiffEntry[] = [];
      walk(ea[i], aa[j], [...path, i], rules, true, ignored, probe);
      if (probe.length === 0) {
        found = j;
        break;
      }
    }
    if (found >= 0) {
      used[found] = true;
    } else {
      push(entries, [...path, i], "value", ea[i], undefined);
    }
  }
  for (let j = 0; j < aa.length; j++) {
    if (!used[j]) push(entries, [...path, j], "value", undefined, aa[j]);
  }
}

/* ------------------------------ convenience ------------------------------ */

function show(v: unknown): string {
  return v === undefined ? "<missing>" : (JSON.stringify(v) ?? String(v));
}

/** Throw an Error listing all minimal difference paths when snapshots differ. */
export function assertSnapshotsEqual(
  expected: JsonValue,
  actual: JsonValue,
  options: DiffOptions = {},
): void {
  const entries = diff(expected, actual, options);
  if (entries.length === 0) return;
  const lines = entries.map(
    (en) => `  ${en.path} [${en.kind}]\n    expected: ${show(en.expected)}\n    actual:   ${show(en.actual)}`,
  );
  throw new Error(
    `Snapshot mismatch (${entries.length} difference${entries.length === 1 ? "" : "s"}):\n${lines.join("\n")}`,
  );
}
