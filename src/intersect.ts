// Intersection of two policy rules, witness URL generation, and the
// empty-intersection (explicitly forbidden) failure mode.

import {
  Rule,
  UrlParts,
  canonicalize,
  freshSubdomain,
  hostSetIsEmpty,
  isStrictSubdomain,
  matchUrl,
} from "./model";

export class EmptyIntersectionError extends Error {
  readonly reasons: string[];
  constructor(reasons: string[]) {
    super(`empty intersection (forbidden): ${reasons.join("; ")}`);
    this.reasons = reasons;
  }
}

function minBudget(a: number | null, b: number | null): number | null {
  if (a === null) return b;
  if (b === null) return a;
  return Math.min(a, b);
}

// Host-set intersection, symbolically:
//   positive(A) = exacts(A) u allow(A) u strict-subdomains(wildcards(A))
//   hosts(A)    = positive(A) \ exclude(A)
//   hosts(A n B) = (positive(A) n positive(B)) \ (exclude(A) u exclude(B))
// The positive part decomposes into exact n exact, exact n wildcard (both
// directions) and wildcard n wildcard (per root pair, the deeper root wins
// when the two roots are suffix-comparable, otherwise nothing).
export function intersectRules(a: Rule, b: Rule): Rule {
  const reasons: string[] = [];

  const protocols = a.protocols.filter((p) => b.protocols.includes(p));
  if (protocols.length === 0) reasons.push("no common protocol");

  const ports = a.ports.filter((p) => b.ports.includes(p));
  if (ports.length === 0) reasons.push("no common port");

  const exactsA = new Set([...a.exactDomains, ...a.allowSubdomains]);
  const exactsB = new Set([...b.exactDomains, ...b.allowSubdomains]);
  const exacts = new Set<string>();
  for (const host of exactsA) {
    if (exactsB.has(host) || b.wildcardDomains.some((r) => isStrictSubdomain(host, r))) {
      exacts.add(host);
    }
  }
  for (const host of exactsB) {
    if (a.wildcardDomains.some((r) => isStrictSubdomain(host, r))) {
      exacts.add(host);
    }
  }

  const wildcards = new Set<string>();
  for (const rootA of a.wildcardDomains) {
    for (const rootB of b.wildcardDomains) {
      if (rootA === rootB) wildcards.add(rootA);
      else if (isStrictSubdomain(rootA, rootB)) wildcards.add(rootA);
      else if (isStrictSubdomain(rootB, rootA)) wildcards.add(rootB);
    }
  }

  const excludes = new Set<string>([...a.excludeSubdomains, ...b.excludeSubdomains]);

  const merged: Rule = {
    name: `(${a.name}) & (${b.name})`,
    protocols,
    ports,
    exactDomains: [...exacts],
    wildcardDomains: [...wildcards],
    allowSubdomains: [],
    excludeSubdomains: [...excludes],
    maxRedirects: minBudget(a.maxRedirects, b.maxRedirects),
  };
  const rule = canonicalize(merged);

  if (hostSetIsEmpty(rule)) {
    reasons.push(
      "no common host: exact/allow/wildcard sets do not overlap after applying exclusions"
    );
  }
  if (reasons.length > 0) throw new EmptyIntersectionError(reasons);
  return rule;
}

// A witness URL accepted by the intersection (and therefore by both sources).
export function witnessUrl(rule: Rule): UrlParts {
  const protocol = rule.protocols[0];
  const port = rule.ports[0];
  if (protocol === undefined || port === undefined) {
    throw new Error("cannot build a witness for a rule with no protocol or port");
  }
  const exact = rule.exactDomains[0];
  if (exact !== undefined) return { protocol, host: exact, port };
  const root = rule.wildcardDomains[0];
  if (root === undefined) {
    throw new Error("cannot build a witness for a rule with an empty host set");
  }
  return { protocol, host: freshSubdomain(root, new Set(rule.excludeSubdomains)), port };
}

export function verifyWitness(witness: UrlParts, a: Rule, b: Rule, intersection: Rule): boolean {
  return matchUrl(a, witness) && matchUrl(b, witness) && matchUrl(intersection, witness);
}
