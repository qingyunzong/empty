import { formatPath, matchAnyRule, parseRule, type PathSeg, type RuleSeg } from "./paths.js";

/** Sentinel marking "no value on this side" inside a DiffEntry. */
export const MISSING: unique symbol = Symbol("snapshot-diff/missing");
export type Missing = typeof MISSING;

export type DiffReason =
  | "value" // same type, different primitive value
  | "type" // different runtime types (incl. array vs object)
  | "missing-key" // present in expected, absent in actual
  | "unexpected-key" // absent in expected, present in actual
  | "array-length"; // same path, different array lengths

export interface DiffEntry {
  /** Canonical public path, e.g. "$.users[2].name". */
  path: string;
  reason: DiffReason;
  /** Original value from the expected side (MISSING if absent). */
  expected: unknown;
  /** Original value from the actual side (MISSING if absent). */
  actual: unknown;
}

export interface DiffResult {
  equal: boolean;
  /** Minimal set of differing paths, with both original values. */
  diffs: DiffEntry[];
  /** Ignore rules that never matched any path (likely config mistakes). */
  unusedRules: string[];
}

/**
 * Compares `expected` against `actual`.
 *
 * - Array order is significant; arrays are compared element by element.
 * - Ignore rules only exempt the *value* at an exactly matched path where
 *   both sides hold a value. They can never mask structural errors:
 *   missing/unexpected keys and array-length mismatches are always
 *   reported, even when the path matches a rule.
 * - Diffs are reported at the most precise (deepest) path possible, each
 *   with both original (un-normalized) values.
 */
export function diff(expected: unknown, actual: unknown, rules: readonly string[] = []): DiffResult {
  const compiled = rules.map(parseRule);
  const used = new Set<number>();
  const diffs: DiffEntry[] = [];
  walk(expected, actual, compiled, used, [], diffs);
  const unusedRules = rules.filter((_, i) => !used.has(i));
  return { equal: diffs.length === 0, diffs, unusedRules };
}

function walk(
  exp: unknown,
  act: unknown,
  rules: readonly (readonly RuleSeg[])[],
  used: Set<number>,
  path: PathSeg[],
  diffs: DiffEntry[],
): void {
  const hit = matchAnyRule(rules, path);
  if (hit >= 0) {
    // Both sides reached this path, so both hold a value here: exempt it.
    used.add(hit);
    return;
  }
  const expObj = typeof exp === "object" && exp !== null;
  const actObj = typeof act === "object" && act !== null;
  if (expObj && actObj) {
    const expArr = Array.isArray(exp);
    const actArr = Array.isArray(act);
    if (expArr !== actArr) {
      diffs.push({ path: formatPath(path), reason: "type", expected: exp, actual: act });
      return;
    }
    if (expArr && actArr) {
      if (exp.length !== act.length) {
        diffs.push({
          path: formatPath(path),
          reason: "array-length",
          expected: exp.length,
          actual: act.length,
        });
      }
      const n = Math.min(exp.length, act.length);
      for (let i = 0; i < n; i += 1) {
        path.push(i);
        walk(exp[i], act[i], rules, used, path, diffs);
        path.pop();
      }
      return;
    }
    const expRec = exp as Record<string, unknown>;
    const actRec = act as Record<string, unknown>;
    for (const key of Object.keys(expRec)) {
      path.push(key);
      if (!Object.prototype.hasOwnProperty.call(actRec, key)) {
        // Structural error: reported even if a rule matches this path.
        diffs.push({ path: formatPath(path), reason: "missing-key", expected: expRec[key], actual: MISSING });
      } else {
        walk(expRec[key], actRec[key], rules, used, path, diffs);
      }
      path.pop();
    }
    for (const key of Object.keys(actRec)) {
      if (!Object.prototype.hasOwnProperty.call(expRec, key)) {
        path.push(key);
        diffs.push({ path: formatPath(path), reason: "unexpected-key", expected: MISSING, actual: actRec[key] });
        path.pop();
      }
    }
    return;
  }
  if (expObj !== actObj) {
    diffs.push({ path: formatPath(path), reason: "type", expected: exp, actual: act });
    return;
  }
  if (!Object.is(exp, act)) {
    const reason: DiffReason = typeof exp !== typeof act ? "type" : "value";
    diffs.push({ path: formatPath(path), reason, expected: exp, actual: act });
  }
}

function render(value: unknown): string {
  if (value === MISSING) return "<missing>";
  return JSON.stringify(value) ?? String(value);
}

/** Human-readable report of a DiffResult, one line per minimal diff path. */
export function formatDiffs(result: DiffResult): string {
  if (result.equal) return "no differences";
  const lines = result.diffs.map(
    (d) => `${d.path} [${d.reason}]\n  expected: ${render(d.expected)}\n  actual:   ${render(d.actual)}`,
  );
  if (result.unusedRules.length > 0) {
    lines.push(`unused ignore rules: ${result.unusedRules.map((r) => JSON.stringify(r)).join(", ")}`);
  }
  return lines.join("\n");
}
