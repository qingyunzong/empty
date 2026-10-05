import { matchAnyRule, parseRule, type PathSeg, type RuleSeg } from "./paths.js";

/** Placeholder substituted for every ignored (volatile) subtree. */
export const IGNORED_PLACEHOLDER = "__SNAPSHOT_IGNORED__";

export type JsonValue =
  | string
  | number
  | boolean
  | null
  | JsonValue[]
  | { [key: string]: JsonValue };

/**
 * Returns a deep copy of `value` with every subtree matched by an ignore
 * rule replaced by IGNORED_PLACEHOLDER. The input is never mutated.
 *
 * Idempotent: normalize(normalize(v, rules), rules) deep-equals
 * normalize(v, rules), because a matched path is replaced by a constant
 * and matching depends only on the path, not the value.
 *
 * `used`, when given, is filled with the indexes of the rules that matched
 * at least one path.
 */
export function normalize<T>(
  value: T,
  rules: readonly (string | readonly RuleSeg[])[],
  used?: Set<number>,
): T {
  const compiled = rules.map((r) => (typeof r === "string" ? parseRule(r) : r));
  return walk(value, compiled, [], used) as T;
}

function walk(
  node: unknown,
  rules: readonly (readonly RuleSeg[])[],
  path: PathSeg[],
  used: Set<number> | undefined,
): unknown {
  const hit = matchAnyRule(rules, path);
  if (hit >= 0) {
    used?.add(hit);
    return IGNORED_PLACEHOLDER;
  }
  if (Array.isArray(node)) {
    const out: unknown[] = new Array(node.length);
    for (let i = 0; i < node.length; i += 1) {
      path.push(i);
      out[i] = walk(node[i], rules, path, used);
      path.pop();
    }
    return out;
  }
  if (typeof node === "object" && node !== null) {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(node)) {
      path.push(key);
      out[key] = walk((node as Record<string, unknown>)[key], rules, path, used);
      path.pop();
    }
    return out;
  }
  return node;
}
