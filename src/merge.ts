import {
  clone,
  deepEqual,
  digest,
  formatPath,
  getAtPath,
  isPlainObject,
  pathKey,
  type JsonObject,
  type JsonValue,
} from "./json.js";
import {
  indexResolutions,
  matchResolution,
  pickValue,
  type Resolution,
  type StaleReason,
} from "./resolution.js";
import { diff, type DiffOp } from "./diff.js";

export type ConflictStatus = "pending" | "reopened";

/** Full provenance for one conflicting field. */
export interface ConflictInfo {
  path: string[];
  displayPath: string;
  status: ConflictStatus;
  /** Source values at the conflicted path (undefined = absent on that side). */
  base: JsonValue | undefined;
  ours: JsonValue | undefined;
  theirs: JsonValue | undefined;
  baseDigest: string;
  oursDigest: string;
  theirsDigest: string;
  /** Which sides diverged from base: "both", "ours-only", "theirs-only". */
  origin: "both";
  /** Present when status === "reopened": the stale resolution that no longer matches. */
  staleResolution?: Resolution;
  staleReason?: StaleReason;
}

export interface AppliedResolution {
  path: string[];
  displayPath: string;
  resolution: Resolution;
  value: JsonValue | undefined;
}

export interface MergeResult {
  merged: JsonValue;
  /** Unresolved conflicts: never-resolved ("pending") plus stale ("reopened"). */
  conflicts: ConflictInfo[];
  /** Resolutions whose bound digests still matched and were applied. */
  applied: AppliedResolution[];
  /** Final diff from base to merged. */
  diff: DiffOp[];
  /** True when every conflict was resolved. */
  clean: boolean;
}

export interface MergeInput {
  base: JsonValue;
  ours: JsonValue;
  theirs: JsonValue;
  resolutions?: Resolution[];
}

export function merge3(input: MergeInput): MergeResult {
  const { base, ours, theirs } = input;
  const byPath = indexResolutions(input.resolutions ?? []);
  const conflicts: ConflictInfo[] = [];
  const applied: AppliedResolution[] = [];

  const walk = (b: JsonValue | undefined, o: JsonValue | undefined, t: JsonValue | undefined, path: string[]): JsonValue | undefined => {
    if (deepEqual(o, t)) return clone(o as JsonValue);
    if (deepEqual(b, o)) return clone(t as JsonValue);
    if (deepEqual(b, t)) return clone(o as JsonValue);

    if (isPlainObject(o) && isPlainObject(t) && (b === undefined || isPlainObject(b))) {
      const bObj = isPlainObject(b) ? b : {};
      const out: JsonObject = {};
      const keys = new Set([...Object.keys(bObj), ...Object.keys(o), ...Object.keys(t)]);
      for (const key of keys) {
        const child = walk(bObj[key], o[key], t[key], [...path, key]);
        if (child !== undefined) out[key] = child;
      }
      return out;
    }

    // Genuine conflict: both sides changed this field differently.
    const res = byPath.get(pathKey(path));
    const info: ConflictInfo = {
      path: [...path],
      displayPath: formatPath(path),
      status: "pending",
      base: b,
      ours: o,
      theirs: t,
      baseDigest: digest(b),
      oursDigest: digest(o),
      theirsDigest: digest(t),
      origin: "both",
    };
    if (res) {
      const match = matchResolution(res, { ours, theirs });
      if (match.matches) {
        const value = pickValue(res.choice, { base, ours, theirs }, path);
        applied.push({
          path: [...path],
          displayPath: formatPath(path),
          resolution: res,
          value,
        });
        return value === undefined ? undefined : clone(value);
      }
      // Source moved on: stale resolution, conflict reopens.
      info.status = "reopened";
      info.staleResolution = res;
      info.staleReason = match.staleReason;
    }
    conflicts.push(info);
    // Unresolved conflicts keep ours by convention so the merged doc stays total.
    return o === undefined ? undefined : clone(o);
  };

  const merged = walk(base, ours, theirs, []) as JsonValue;
  const result: MergeResult = {
    merged,
    conflicts,
    applied,
    diff: diff(base, merged),
    clean: conflicts.length === 0,
  };
  return result;
}
