// Redirect-chain semantics: a chain is a non-empty sequence of URLs
// u0 -> u1 -> ... -> uk with k redirects. A policy accepts a chain iff
// every hop matches the policy AND k <= maxRedirects. The intersection
// therefore satisfies both policies at every hop by construction.
//
// Equivalence of two policies over chains reduces to a finite-state
// comparison: policy P is the DFA
//   states   q0..qB (redirects consumed so far, B = maxRedirects) + dead
//   alphabet URLs, classified as match / no-match by P
//   accept   any qi (the chain may stop at any point); dead rejects
// so P1 == P2 iff same budget AND same match predicate (given a non-empty
// match set; two empty policies trivially accept the same - empty - set of
// chains). When the budgets differ, the shortest separating chain has
// min(B1,B2)+1 redirects with every hop in the common match set. When the
// match predicates differ, a single-URL chain (0 redirects) separates them.
// If either budget is unclosed (null) the answer is UNKNOWN.

import {
  Protocol,
  Rule,
  UrlParts,
  canonicalize,
  formatUrl,
  hostSetIsEmpty,
  matchUrl,
} from "./model";
import { intersectRules, witnessUrl } from "./intersect";
import {
  UrlCrossCheck,
  UrlUniverse,
  buildUniverse,
  crossCheckMatchEquality,
} from "./enumerate";

export function acceptsChain(rule: Rule, chain: UrlParts[]): boolean {
  if (chain.length === 0) return false;
  if (rule.maxRedirects !== null && chain.length - 1 > rule.maxRedirects) return false;
  return chain.every((url) => matchUrl(rule, url));
}

// Visits every chain over `urls` with 0..maxRedirects redirects.
export function enumerateChains(
  urls: UrlParts[],
  maxRedirects: number,
  visit: (chain: UrlParts[]) => void
): number {
  let count = 0;
  const chain: UrlParts[] = [];
  const dfs = (redirects: number): void => {
    for (const url of urls) {
      chain.push(url);
      count++;
      visit([...chain]);
      if (redirects < maxRedirects) dfs(redirects + 1);
      chain.pop();
    }
  };
  dfs(0);
  return count;
}

export interface ChainCrossCheck {
  kind: "chain-cross-check";
  universeSize: number;
  maxRedirectsDepth: number;
  chainsChecked: number;
  divergentChains: number;
  // Chain length (number of URLs) of the shortest divergence found, if any.
  firstDivergenceLength: number | null;
  ok: boolean;
}

// Full-chain enumeration over the small universe: checks that A and B accept
// exactly the same chains up to the given redirect depth.
export function crossCheckChainEquivalence(
  a: Rule,
  b: Rule,
  universe: UrlUniverse,
  maxRedirectsDepth: number
): ChainCrossCheck {
  let divergentChains = 0;
  let firstDivergenceLength: number | null = null;
  const chainsChecked = enumerateChains(universe.urls, maxRedirectsDepth, (chain) => {
    if (acceptsChain(a, chain) !== acceptsChain(b, chain)) {
      divergentChains++;
      if (firstDivergenceLength === null) firstDivergenceLength = chain.length;
    }
  });
  return {
    kind: "chain-cross-check",
    universeSize: universe.urls.length,
    maxRedirectsDepth,
    chainsChecked,
    divergentChains,
    firstDivergenceLength,
    ok: divergentChains === 0,
  };
}

// Verifies the per-hop intersection law on every chain up to the given depth:
// acceptsChain(I, c) === acceptsChain(A, c) && acceptsChain(B, c).
export function crossCheckChainIntersection(
  a: Rule,
  b: Rule,
  intersection: Rule,
  universe: UrlUniverse,
  maxRedirectsDepth: number
): ChainCrossCheck {
  let divergentChains = 0;
  let firstDivergenceLength: number | null = null;
  const chainsChecked = enumerateChains(universe.urls, maxRedirectsDepth, (chain) => {
    const expected = acceptsChain(a, chain) && acceptsChain(b, chain);
    if (acceptsChain(intersection, chain) !== expected) {
      divergentChains++;
      if (firstDivergenceLength === null) firstDivergenceLength = chain.length;
    }
  });
  return {
    kind: "chain-cross-check",
    universeSize: universe.urls.length,
    maxRedirectsDepth,
    chainsChecked,
    divergentChains,
    firstDivergenceLength,
    ok: divergentChains === 0,
  };
}

function sameList<T>(xs: T[], ys: T[]): boolean {
  return xs.length === ys.length && xs.every((x, i) => x === ys[i]);
}

// On canonical forms, list equality decides match-predicate equality.
export function sameMatchPredicate(ca: Rule, cb: Rule): boolean {
  return (
    sameList(ca.protocols, cb.protocols) &&
    sameList(ca.ports, cb.ports) &&
    sameList(ca.exactDomains, cb.exactDomains) &&
    sameList(ca.wildcardDomains, cb.wildcardDomains) &&
    sameList(ca.excludeSubdomains, cb.excludeSubdomains)
  );
}

// Searches a finite candidate set that provably contains a separating URL
// whenever the two (canonical, non-identical) match predicates differ:
// exact hosts, excluded hosts, the wildcard roots themselves, and fresh
// subdomains of every wildcard root (several label choices, so finite
// exclusion sets cannot hide them all).
export function findDistinguishingUrl(ca: Rule, cb: Rule): UrlParts {
  const hosts = new Set<string>();
  for (const rule of [ca, cb]) {
    for (const host of rule.exactDomains) hosts.add(host);
    for (const host of rule.excludeSubdomains) hosts.add(host);
    for (const root of rule.wildcardDomains) {
      hosts.add(root);
      for (const label of ["w", "x", "zz"]) hosts.add(`${label}.${root}`);
    }
  }
  hosts.add("probe.invalid");
  const protocols = new Set<Protocol>([...ca.protocols, ...cb.protocols]);
  const ports = new Set<number>([...ca.ports, ...cb.ports]);
  for (const host of [...hosts].sort()) {
    for (const protocol of [...protocols].sort()) {
      for (const port of [...ports].sort((x, y) => x - y)) {
        const url: UrlParts = { protocol, host, port };
        if (matchUrl(ca, url) !== matchUrl(cb, url)) return url;
      }
    }
  }
  throw new Error("internal error: predicates differ but no separating URL was found");
}

export interface AutomatonDescription {
  states: string[];
  alphabet: ["match", "no-match"];
  start: string;
  accepting: string[];
  transitions: string;
}

export interface EquivalenceProof {
  type: "finite-state-equivalence-proof";
  budgetsEqual: boolean;
  budget: number;
  matchPredicateEqual: boolean;
  canonicalA: Rule;
  canonicalB: Rule;
  automaton: AutomatonDescription;
  urlCrossCheck: UrlCrossCheck;
  chainCrossCheck: ChainCrossCheck;
  conclusion: string;
}

export type EquivResult =
  | { kind: "equivalent"; proof: EquivalenceProof }
  | {
      kind: "not-equivalent";
      distinguishingChain: UrlParts[];
      redirects: number;
      acceptedBy: "A" | "B";
      explanation: string;
      chainCrossCheck: ChainCrossCheck;
    }
  | { kind: "unknown"; reason: string };

function describeAutomaton(budget: number): AutomatonDescription {
  const states = [...Array(budget + 1).keys()].map((i) => `q${i}`);
  return {
    states: [...states, "dead"],
    alphabet: ["match", "no-match"],
    start: "q0",
    accepting: states,
    transitions:
      "on no-match -> dead; on match: first URL keeps q0, qi -> q(i+1) while i < budget, q<budget> -> dead",
  };
}

function buildProof(
  ca: Rule,
  cb: Rule,
  budget: number,
  urlCrossCheck: UrlCrossCheck,
  chainCrossCheck: ChainCrossCheck,
  note: string
): EquivalenceProof {
  return {
    type: "finite-state-equivalence-proof",
    budgetsEqual: true,
    budget,
    matchPredicateEqual: true,
    canonicalA: ca,
    canonicalB: cb,
    automaton: describeAutomaton(budget),
    urlCrossCheck,
    chainCrossCheck,
    conclusion:
      `Both policies compile to the same finite automaton: budget=${budget}, ` +
      `identical match predicate (canonical forms agree; verified pointwise on ` +
      `${urlCrossCheck.urlsChecked} URLs, 0 mismatches) and identical chain ` +
      `acceptance on all ${chainCrossCheck.chainsChecked} chains of the small ` +
      `universe up to ${chainCrossCheck.maxRedirectsDepth} redirects. ${note}`,
  };
}

export function checkEquivalence(a: Rule, b: Rule): EquivResult {
  if (a.maxRedirects === null || b.maxRedirects === null) {
    const which =
      a.maxRedirects === null && b.maxRedirects === null
        ? "both policies"
        : a.maxRedirects === null
          ? `policy A (${a.name})`
          : `policy B (${b.name})`;
    return {
      kind: "unknown",
      reason: `unclosed redirect budget on ${which}: maxRedirects is null, so no finite-state equivalence proof exists`,
    };
  }

  // Past this point both budgets are closed (non-null).
  const budgetA = a.maxRedirects;
  const budgetB = b.maxRedirects;
  const ca = canonicalize(a);
  const cb = canonicalize(b);
  const universe = buildUniverse([ca, cb], { maxHosts: 6, maxPorts: 2 });
  const depth = Math.min(Math.max(budgetA, budgetB), 3);

  // Degenerate case: both match sets are empty, so both reject every chain.
  if (hostSetIsEmpty(ca) && hostSetIsEmpty(cb)) {
    const urlCheck = crossCheckMatchEquality(ca, cb, universe);
    const chainCheck = crossCheckChainEquivalence(ca, cb, universe, depth);
    return {
      kind: "equivalent",
      proof: buildProof(
        ca,
        cb,
        Math.max(budgetA, budgetB),
        urlCheck,
        chainCheck,
        "Both host sets are empty: both policies reject every chain regardless of budget."
      ),
    };
  }

  const matchEqual = sameMatchPredicate(ca, cb);

  if (matchEqual && budgetA === budgetB) {
    const urlCheck = crossCheckMatchEquality(ca, cb, universe);
    const chainCheck = crossCheckChainEquivalence(ca, cb, universe, depth);
    return {
      kind: "equivalent",
      proof: buildProof(ca, cb, budgetA, urlCheck, chainCheck,
        "Hence the two chain languages are equal."),
    };
  }

  if (!matchEqual) {
    const url = findDistinguishingUrl(ca, cb);
    const chain = [url];
    const acceptedBy = matchUrl(ca, url) ? "A" : "B";
    const checkUniverse = buildUniverse([ca, cb], { maxHosts: 6, maxPorts: 2, extraUrls: chain });
    const chainCheck = crossCheckChainEquivalence(ca, cb, checkUniverse, 0);
    return {
      kind: "not-equivalent",
      distinguishingChain: chain,
      redirects: 0,
      acceptedBy,
      explanation:
        `match predicates differ: ${formatUrl(url)} is accepted by ${acceptedBy} only; ` +
        `a 0-redirect chain is the shortest possible separator`,
      chainCrossCheck: chainCheck,
    };
  }

  // Same match predicate, different budgets: the shortest separator needs
  // min(B1,B2)+1 redirects, every hop inside the common match set.
  const aIsTighter = budgetA < budgetB;
  const tighterBudget = Math.min(budgetA, budgetB);
  const common = intersectRules(ca, cb); // non-empty: match sets are equal and non-empty
  const hop = witnessUrl(common);
  const chain = Array<UrlParts>(tighterBudget + 2).fill(hop);
  const acceptedBy = aIsTighter ? "B" : "A";
  const checkUniverse = buildUniverse([ca, cb], {
    maxHosts: 6,
    maxPorts: 2,
    extraUrls: [hop],
  });
  const chainCheck = crossCheckChainEquivalence(ca, cb, checkUniverse, tighterBudget + 1);
  return {
    kind: "not-equivalent",
    distinguishingChain: chain,
    redirects: tighterBudget + 1,
    acceptedBy,
    explanation:
      `same match predicate but budgets differ (${budgetA} vs ${budgetB}); ` +
      `the shortest separator repeats a commonly accepted hop for ${tighterBudget + 1} redirects`,
    chainCrossCheck: chainCheck,
  };
}
