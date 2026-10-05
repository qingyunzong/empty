import { Policy, UrlParts } from "./types.js";
import { matchUrl } from "./policy.js";
import { formatUrl } from "./enumerate.js";

// A redirect chain is a sequence of URLs; a chain of n URLs contains
// n - 1 redirects. An acceptor accepts iff every hop matches its per-hop
// predicate and the redirect count fits its budget (null = unbounded).
export interface AcceptorSpec {
  matches: (url: UrlParts) => boolean;
  budget: number | null;
  accept: (chain: UrlParts[]) => boolean;
}

export function policyAcceptor(p: Policy): AcceptorSpec {
  return {
    matches: (url) => matchUrl(p, url),
    budget: p.redirectBudget,
    accept: (chain) => {
      const redirects = chain.length - 1;
      if (p.redirectBudget !== null && redirects > p.redirectBudget) return false;
      return chain.every((u) => matchUrl(p, u));
    },
  };
}

// Per-hop conjunction: every hop must satisfy BOTH policies, and the chain
// must fit both budgets.
export function conjunctionAcceptor(a: Policy, b: Policy): AcceptorSpec {
  const pa = policyAcceptor(a);
  const pb = policyAcceptor(b);
  const budget =
    a.redirectBudget === null
      ? b.redirectBudget
      : b.redirectBudget === null
        ? a.redirectBudget
        : Math.min(a.redirectBudget, b.redirectBudget);
  return {
    matches: (url) => pa.matches(url) && pb.matches(url),
    budget,
    accept: (chain) => pa.accept(chain) && pb.accept(chain),
  };
}

// Shortest redirect chain accepted differently by x and y, or null when
// the two acceptors agree on every chain over the finite universe.
//
// Acceptance is a conjunction of a memoryless per-hop predicate and a
// global redirect-count bound, so a shortest counterexample is either:
//   1. a single URL on which the per-hop predicates disagree, or
//   2. a chain of min(budgetX, budgetY) + 1 redirects made of URLs the
//      looser acceptor's predicate accepts (budget boundary).
export function shortestDifferingChain(
  x: AcceptorSpec,
  y: AcceptorSpec,
  universe: UrlParts[]
): UrlParts[] | null {
  for (const u of universe) {
    if (x.accept([u]) !== y.accept([u])) return [u];
  }
  if (x.budget === y.budget) return null;

  const inf = Number.POSITIVE_INFINITY;
  const bx = x.budget === null ? inf : x.budget;
  const by = y.budget === null ? inf : y.budget;
  const lo = Math.min(bx, by);
  if (lo === inf) return null; // both unbounded: budgets cannot differ
  const looser = bx > by ? x : y;
  const witness = universe.find((u) => looser.matches(u));
  if (!witness) return null;
  const chain: UrlParts[] = [];
  for (let i = 0; i < lo + 2; i++) chain.push(witness);
  return x.accept(chain) !== y.accept(chain) ? chain : null;
}

export interface ChainEnumeration {
  reducedUniverseSize: number;
  maxChainLength: number;
  chainsChecked: number;
  mismatches: { chain: string[]; intersection: boolean; conjunction: boolean }[];
}

// Small-domain full-chain enumeration: exhaustively compare both acceptors
// on EVERY chain (up to the length cap) over a reduced URL universe.
export function enumerateChains(
  x: AcceptorSpec,
  y: AcceptorSpec,
  universe: UrlParts[],
  budget: number,
  reducedSize = 8,
  lengthCap = 4
): ChainEnumeration {
  const accepted = universe.filter((u) => x.matches(u)).slice(0, reducedSize / 2);
  const rejected = universe.filter((u) => !x.matches(u));
  const reduced = [...accepted];
  for (const u of rejected) {
    if (reduced.length >= reducedSize) break;
    reduced.push(u);
  }

  const maxLen = Math.min(budget + 2, lengthCap);
  const result: ChainEnumeration = {
    reducedUniverseSize: reduced.length,
    maxChainLength: maxLen,
    chainsChecked: 0,
    mismatches: [],
  };

  const chain: UrlParts[] = [];
  const visit = (depth: number): void => {
    result.chainsChecked++;
    const byX = x.accept(chain);
    const byY = y.accept(chain);
    if (byX !== byY && result.mismatches.length < 10) {
      result.mismatches.push({ chain: chain.map(formatUrl), intersection: byX, conjunction: byY });
    }
    if (depth >= maxLen) return;
    for (const u of reduced) {
      chain.push(u);
      visit(depth + 1);
      chain.pop();
    }
  };
  for (const u of reduced) {
    chain.push(u);
    visit(1);
    chain.pop();
  }
  return result;
}

export type RedirectVerdict =
  | { status: "equivalent"; proof: FiniteStateProof }
  | { status: "different"; shortestChain: string[]; acceptedByIntersection: boolean }
  | { status: "unknown"; reason: string };

export interface FiniteStateProof {
  model: "finite-state";
  stateSpace: string;
  urlUniverseSize: number;
  budget: number;
  perHopPredicatesAgree: boolean;
  budgetsEqual: boolean;
  chainsEnumerated: number;
  chainMismatches: number;
  conclusion: string;
}

// Verify that the intersection policy, applied to redirect chains, accepts
// exactly the chains accepted by applying BOTH source policies per hop.
//
// The state space is UrlUniverse x {0..budget}; it is finite only when the
// budget is bounded. An unbounded (null) budget leaves the model unclosed,
// so the verdict is "unknown".
export function verifyRedirectEquivalence(
  a: Policy,
  b: Policy,
  intersection: Policy,
  universe: UrlParts[]
): RedirectVerdict {
  const ix = policyAcceptor(intersection);
  const both = conjunctionAcceptor(a, b);

  if (intersection.redirectBudget === null || both.budget === null) {
    return {
      status: "unknown",
      reason: "redirect budget is unbounded; the finite-state model cannot be closed",
    };
  }
  const budget = intersection.redirectBudget;

  const perHopAgree = universe.every((u) => ix.matches(u) === both.matches(u));
  const budgetsEqual = ix.budget === both.budget;

  const enumeration = enumerateChains(ix, both, universe, budget);

  if (perHopAgree && budgetsEqual && enumeration.mismatches.length === 0) {
    return {
      status: "equivalent",
      proof: {
        model: "finite-state",
        stateSpace: `${universe.length} URLs x hop counts 0..${budget}`,
        urlUniverseSize: universe.length,
        budget,
        perHopPredicatesAgree: true,
        budgetsEqual: true,
        chainsEnumerated: enumeration.chainsChecked,
        chainMismatches: 0,
        conclusion:
          "per-hop predicates agree on the whole URL universe and budgets are equal; " +
          "chain acceptance is the conjunction of a memoryless per-hop predicate and " +
          "the redirect-count bound, so by induction on chain length the two acceptors " +
          "are equivalent for every chain within the budget",
      },
    };
  }

  const diff = shortestDifferingChain(ix, both, universe);
  if (diff) {
    return {
      status: "different",
      shortestChain: diff.map(formatUrl),
      acceptedByIntersection: ix.accept(diff),
    };
  }
  // Enumeration disagrees but the constructive search found nothing: report
  // the first enumerated mismatching chain as the shortest known witness.
  const first = enumeration.mismatches[0]!;
  return {
    status: "different",
    shortestChain: first.chain,
    acceptedByIntersection: first.intersection,
  };
}
