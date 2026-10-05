/**
 * Domain rules.
 *
 * Two rule forms over normalized ASCII domains:
 *  - exact:    `example.com`      matches only `example.com` itself
 *  - wildcard: `*.example.com`    matches any name with at least one label
 *                                 to the left of `example.com`
 *                                 (e.g. `a.example.com`, `a.b.example.com`),
 *                                 but NOT `example.com` itself.
 *
 * Wildcard syntax restrictions: `*` is only allowed as the entire leftmost
 * label, and the wildcard must have at least one suffix label (`*.com` is
 * legal, bare `*` is not).
 */

import { normalizeDomain, type DomainError } from "./domain.js";

export type Rule =
  | { kind: "exact"; domain: string }
  | { kind: "wildcard"; suffix: string };

export type RuleError = DomainError | "BAD_WILDCARD" | "WILDCARD_NO_SUFFIX";

export type ParseRuleResult =
  | { ok: true; rule: Rule }
  | { ok: false; error: RuleError; detail: string };

export function parseRule(raw: string): ParseRuleResult {
  if (raw.length === 0) {
    return { ok: false, error: "EMPTY_INPUT", detail: "input is empty" };
  }
  for (let i = 0; i < raw.length; i++) {
    if (raw.charCodeAt(i) > 0x7f) {
      return {
        ok: false,
        error: "NON_ASCII",
        detail: `non-ASCII character U+${raw.charCodeAt(i).toString(16).toUpperCase()} at index ${i}`,
      };
    }
  }
  let text = raw.toLowerCase();
  if (text.endsWith(".")) text = text.slice(0, -1);

  const labels = text.split(".");
  const starAt: number[] = [];
  labels.forEach((label, i) => {
    if (label.includes("*")) starAt.push(i);
  });

  if (starAt.length > 0) {
    // `*` may appear only as the entire leftmost label.
    if (starAt.length > 1 || starAt[0] !== 0 || labels[0] !== "*") {
      return {
        ok: false,
        error: "BAD_WILDCARD",
        detail: "wildcard is only allowed as the entire leftmost label",
      };
    }
    if (labels.length < 2) {
      return {
        ok: false,
        error: "WILDCARD_NO_SUFFIX",
        detail: "wildcard needs at least one suffix label (`*` alone is not a rule)",
      };
    }
    const suffix = labels.slice(1).join(".");
    const norm = normalizeDomain(suffix);
    if (!norm.ok) return norm;
    return { ok: true, rule: { kind: "wildcard", suffix: norm.domain } };
  }

  const norm = normalizeDomain(text);
  if (!norm.ok) return norm;
  return { ok: true, rule: { kind: "exact", domain: norm.domain } };
}

/** Structural matcher: does `rule` match the (raw, unnormalized) domain? */
export function matches(rule: Rule, rawDomain: string): boolean {
  const norm = normalizeDomain(rawDomain);
  if (!norm.ok) return false;
  const d = norm.domain;
  if (rule.kind === "exact") return d === rule.domain;
  return d.endsWith("." + rule.suffix);
}

/**
 * Inclusion: `includes(a, b)` is true iff every domain matched by `b`
 * is also matched by `a` (a's match set is a superset of b's).
 *
 * Decision procedure:
 *  - b exact:    a ⊇ b  iff a matches b's single domain.
 *  - b wildcard: its set is infinite, so a must be a wildcard whose suffix
 *                is a suffix of (or equal to) b's suffix.
 */
export function includes(a: Rule, b: Rule): boolean {
  if (b.kind === "exact") return matches(a, b.domain);
  if (a.kind === "exact") return false;
  return b.suffix === a.suffix || b.suffix.endsWith("." + a.suffix);
}

/**
 * When a ⊉ b, return a concrete domain matched by b but not by a.
 * Returns null when a ⊇ b (no counterexample exists).
 */
export function counterexample(a: Rule, b: Rule): string | null {
  if (includes(a, b)) return null;
  if (b.kind === "exact") return b.domain; // a does not match it, by definition
  // b is a wildcard: try `<label>.<suffix>` until one escapes a.
  // An exact a can shadow at most one candidate; a wildcard a that does
  // not include b shadows none (any proper-suffix match would imply a ⊇ b).
  for (const label of ["x", "y", "z", "w"]) {
    const candidate = `${label}.${b.suffix}`;
    if (!matches(a, candidate)) return candidate;
  }
  for (let i = 0; ; i++) {
    const candidate = `w${i}.${b.suffix}`;
    if (!matches(a, candidate)) return candidate;
  }
}

export type Relation =
  | "equivalent"        // a ⊇ b and b ⊇ a
  | "includes"          // a ⊋ b (strict)
  | "included-by"       // b ⊋ a (strict)
  | "incomparable";     // neither includes the other (in this rule
                        // system that also implies disjoint match sets)

export function relate(a: Rule, b: Rule): Relation {
  const ab = includes(a, b);
  const ba = includes(b, a);
  if (ab && ba) return "equivalent";
  if (ab) return "includes";
  if (ba) return "included-by";
  return "incomparable";
}

export function formatRule(rule: Rule): string {
  return rule.kind === "exact" ? rule.domain : `*.${rule.suffix}`;
}
