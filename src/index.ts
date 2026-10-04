import { createHash } from "node:crypto";

export type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };

/** Sentinel meaning "field is absent" (deleted or never present). */
export const ABSENT: unique symbol = Symbol("ABSENT");
export type Absent = typeof ABSENT;
export type Slot = JsonValue | Absent;
export type Doc = Record<string, JsonValue>;

function canonical(slot: Slot): string {
  if (slot === ABSENT) return " absent";
  const v = slot as JsonValue;
  if (v === null || typeof v !== "object") return JSON.stringify(v);
  if (Array.isArray(v)) return "[" + v.map((x) => canonical(x)).join(",") + "]";
  const keys = Object.keys(v).sort();
  return "{" + keys.map((k) => JSON.stringify(k) + ":" + canonical(v[k]!)).join(",") + "}";
}

/** SHA-256 summary of one side's value for a field. */
export function digest(slot: Slot): string {
  return createHash("sha256").update(canonical(slot)).digest("hex");
}

export function slotEqual(a: Slot, b: Slot): boolean {
  return canonical(a) === canonical(b);
}

/**
 * A resolution choice bound to the digests of BOTH sides' source values
 * as they were when the choice was made. It stays valid only while both
 * sides still hash to the same summaries.
 */
export interface ResolutionEntry {
  value: Slot;
  leftDigest: string;
  rightDigest: string;
}

/** Per-field resolution choices; each field is carried independently. */
export type ResolutionStore = Record<string, ResolutionEntry>;

export type ConflictCause = "both-modified" | "stale-resolution";

export interface Conflict {
  field: string;
  base: Slot;
  left: Slot;
  right: Slot;
  leftDigest: string;
  rightDigest: string;
  cause: ConflictCause;
  /** The expired choice, present when cause is "stale-resolution". */
  stale?: ResolutionEntry;
}

export type DiffOp = "added" | "removed" | "changed";
export interface DiffEntry {
  field: string;
  op: DiffOp;
  from: Slot;
  to: Slot;
}

export interface MergeResult {
  merged: Doc;
  conflicts: Conflict[];
  /** Fields whose stored choice was reused this round. */
  applied: string[];
  /** Store entries still bound to current sources (stale ones dropped). */
  carriedStore: ResolutionStore;
  /** Final diff from base to merged. */
  diff: DiffEntry[];
}

function get(doc: Doc, field: string): Slot {
  return Object.prototype.hasOwnProperty.call(doc, field) ? doc[field]! : ABSENT;
}

/** Bind a choice for a conflict to the digests of its current sources. */
export function resolve(conflict: Conflict, value: Slot): ResolutionEntry {
  return { value, leftDigest: conflict.leftDigest, rightDigest: conflict.rightDigest };
}

export function merge(base: Doc, left: Doc, right: Doc, store: ResolutionStore = {}): MergeResult {
  const fields = new Set([...Object.keys(base), ...Object.keys(left), ...Object.keys(right)]);
  const merged: Doc = {};
  const conflicts: Conflict[] = [];
  const applied: string[] = [];
  const carriedStore: ResolutionStore = {};

  for (const field of [...fields].sort()) {
    const b = get(base, field);
    const l = get(left, field);
    const r = get(right, field);
    const leftChanged = !slotEqual(b, l);
    const rightChanged = !slotEqual(b, r);

    let outcome: Slot;
    if (!leftChanged && !rightChanged) {
      outcome = b;
    } else if (leftChanged && !rightChanged) {
      outcome = l;
    } else if (rightChanged && !leftChanged) {
      outcome = r;
    } else if (slotEqual(l, r)) {
      outcome = l;
    } else {
      const ld = digest(l);
      const rd = digest(r);
      const entry = store[field];
      if (entry && entry.leftDigest === ld && entry.rightDigest === rd) {
        outcome = entry.value;
        applied.push(field);
        carriedStore[field] = entry;
      } else {
        const conflict: Conflict = {
          field, base: b, left: l, right: r,
          leftDigest: ld, rightDigest: rd,
          cause: entry ? "stale-resolution" : "both-modified",
        };
        if (entry) conflict.stale = entry;
        conflicts.push(conflict);
        continue; // unresolved: field omitted from merged output
      }
    }
    if (outcome !== ABSENT) merged[field] = outcome;
  }

  const diff: DiffEntry[] = [];
  for (const field of [...fields].sort()) {
    const from = get(base, field);
    const to = get(merged, field);
    if (slotEqual(from, to)) continue;
    const op: DiffOp = from === ABSENT ? "added" : to === ABSENT ? "removed" : "changed";
    diff.push({ field, op, from, to });
  }

  return { merged, conflicts, applied, carriedStore, diff };
}
