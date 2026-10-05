import { normalizeDomain } from "./domain.js";

/**
 * A domain rule.
 *  - exact:    matches exactly one domain ("example.com")
 *  - wildcard: "*.example.com" matches exactly one label below the base
 *              ("a.example.com"), never the base itself and never deeper
 *              levels ("a.b.example.com").
 */
export type Rule =
  | { kind: "exact"; domain: string }
  | { kind: "wildcard"; base: string };

export type ParseResult =
  | { ok: true; rule: Rule }
  | { ok: false; error: string };

function fail(error: string): ParseResult {
  return { ok: false, error };
}

/**
 * Parse a rule. Wildcards are only allowed as the entire leftmost label
 * and must sit above at least one label ("*.example.com" is valid,
 * "*", "ex*.com", "a.*.com" are not).
 */
export function parseRule(input: string): ParseResult {
  if (typeof input !== "string" || input.length === 0) {
    return fail("empty rule");
  }
  for (const ch of input) {
    const code = ch.charCodeAt(0);
    if (code > 0x7f) {
      return fail(
        `non-ASCII character U+${code.toString(16).padStart(4, "0")}: illegal encoding`,
      );
    }
  }

  let text = input.toLowerCase();
  if (text === "*") {
    return fail("bare wildcard: wildcard must be the leftmost label above at least one label");
  }
  if (text.startsWith("*.")) {
    const rest = text.slice(2);
    if (rest.includes("*")) {
      return fail("wildcard is only allowed as the entire leftmost label");
    }
    const base = normalizeDomain(rest);
    if (!base.ok) {
      return fail(base.error);
    }
    return { ok: true, rule: { kind: "wildcard", base: base.domain } };
  }
  if (text.includes("*")) {
    return fail("wildcard is only allowed as the entire leftmost label");
  }

  const exact = normalizeDomain(text);
  if (!exact.ok) {
    return fail(exact.error);
  }
  return { ok: true, rule: { kind: "exact", domain: exact.domain } };
}

/** Render a rule back to its canonical textual form. */
export function formatRule(rule: Rule): string {
  return rule.kind === "exact" ? rule.domain : `*.${rule.base}`;
}

/** Does the rule match the given (not yet normalized) domain? */
export function matches(rule: Rule, input: string): boolean {
  const normalized = normalizeDomain(input);
  if (!normalized.ok) {
    return false;
  }
  if (rule.kind === "exact") {
    return normalized.domain === rule.domain;
  }
  const suffix = "." + rule.base;
  if (!normalized.domain.endsWith(suffix)) {
    return false;
  }
  const head = normalized.domain.slice(0, normalized.domain.length - suffix.length);
  return head.length > 0 && !head.includes(".");
}

/**
 * Containment: does rule `a` match every domain that rule `b` matches?
 *
 *  - exact(D1)    ⊇ exact(D2)    ⟺ D1 === D2
 *  - exact(_)     ⊇ wildcard(_)  ⟺ never (a wildcard matches infinitely many)
 *  - wildcard(B1) ⊇ exact(D2)    ⟺ D2 is one label below B1
 *  - wildcard(B1) ⊇ wildcard(B2) ⟺ B1 === B2
 */
export function contains(a: Rule, b: Rule): boolean {
  if (a.kind === "exact") {
    return b.kind === "exact" && a.domain === b.domain;
  }
  if (b.kind === "exact") {
    return matches(a, b.domain);
  }
  return a.base === b.base;
}

/**
 * If `a` does NOT contain `b`, return a concrete domain matched by `b`
 * but not by `a`; otherwise return null.
 */
export function counterexample(a: Rule, b: Rule): string | null {
  if (contains(a, b)) {
    return null;
  }
  if (b.kind === "exact") {
    return b.domain;
  }
  // b is a wildcard and matches infinitely many domains; find one outside a.
  for (const label of ["x", "y", "z", "w"]) {
    const candidate = `${label}.${b.base}`;
    if (!matches(a, candidate)) {
      return candidate;
    }
  }
  throw new Error("unreachable: an exact rule cannot cover four distinct domains");
}

export type Relation = "equal" | "superset" | "subset" | "disjoint";

/** Classify the containment relation between two rules. */
export function relate(a: Rule, b: Rule): Relation {
  const ab = contains(a, b);
  const ba = contains(b, a);
  if (ab && ba) return "equal";
  if (ab) return "superset";
  if (ba) return "subset";
  return "disjoint";
}
