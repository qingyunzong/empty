/**
 * Exhaustive enumeration over a tiny label alphabet, used to cross-check
 * the symbolic inclusion procedure against brute-force matching.
 *
 * Completeness argument: for rules whose suffix/domain has depth <= D,
 * any inclusion violation is witnessed by a domain of depth <= D + 1
 * (see counterexample(): witnesses are either b's exact domain, depth <= D,
 * or one extra label over b's suffix, depth <= D + 1). So enumerating all
 * domains up to depth D + 1 is a *complete* decision procedure, not a sample.
 */

import { matches, type Rule } from "./rules.js";

/** All domains of depth 1..maxDepth over the given label alphabet. */
export function enumerateDomains(alphabet: string[], maxDepth: number): string[] {
  const out: string[] = [];
  let level: string[] = [...alphabet];
  for (let depth = 1; depth <= maxDepth; depth++) {
    out.push(...level);
    const next: string[] = [];
    for (const label of alphabet) {
      for (const d of level) next.push(`${label}.${d}`);
    }
    level = next;
  }
  return out;
}

/** All rules (exact + wildcard) whose domain/suffix has depth 1..maxDepth. */
export function enumerateRules(alphabet: string[], maxDepth: number): Rule[] {
  const domains = enumerateDomains(alphabet, maxDepth);
  const rules: Rule[] = [];
  for (const d of domains) {
    rules.push({ kind: "exact", domain: d });
    rules.push({ kind: "wildcard", suffix: d });
  }
  return rules;
}

/**
 * Independent naive matcher, written differently on purpose (label-array
 * comparison instead of string suffix tests) for differential checking.
 */
export function naiveMatches(rule: Rule, domain: string): boolean {
  const dLabels = domain.split(".");
  if (rule.kind === "exact") {
    const rLabels = rule.domain.split(".");
    return rLabels.length === dLabels.length && rLabels.every((l, i) => l === dLabels[i]);
  }
  const sLabels = rule.suffix.split(".");
  if (dLabels.length <= sLabels.length) return false;
  return sLabels.every((l, i) => l === dLabels[dLabels.length - sLabels.length + i]);
}

/** Brute-force inclusion over a finite (but complete, see header) universe. */
export function bruteForceIncludes(a: Rule, b: Rule, universe: string[]): boolean {
  return universe.every((d) => !matches(b, d) || matches(a, d));
}
