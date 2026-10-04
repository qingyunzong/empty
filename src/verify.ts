import type {
  CountCertificate,
  LogEvent,
  MatchingEntry,
  Requirement,
  SearchResult,
  VerificationCheck,
  VerificationReport,
} from "./model.js";

/**
 * Independent feasibility oracle used only for verification. Deliberately
 * implemented separately from the production matcher: requirements are
 * assigned in natural index order, and prerequisite / mutex constraints are
 * re-checked from scratch on every complete assignment.
 */
function matchingExistsIndependent(
  events: readonly LogEvent[],
  lo: number,
  hi: number,
  reqs: readonly Requirement[],
): boolean {
  const assign = new Array<number>(reqs.length).fill(-1);
  const used = new Array<boolean>(hi - lo + 1).fill(false);

  function constraintsHold(): boolean {
    for (let i = 0; i < reqs.length; i++) {
      for (const p of reqs[i]!.prereqs ?? []) {
        if (assign[i]! <= assign[p]!) return false;
      }
    }
    const groupSources = new Map<string, Set<string>>();
    for (let i = 0; i < reqs.length; i++) {
      const group = reqs[i]!.mutexGroup;
      if (group === undefined) continue;
      const source = events[assign[i]!]!.source;
      let sources = groupSources.get(group);
      if (sources === undefined) {
        sources = new Set();
        groupSources.set(group, sources);
      }
      if (sources.has(source)) return false;
      sources.add(source);
    }
    return true;
  }

  function dfs(i: number): boolean {
    if (i === reqs.length) return constraintsHold();
    // Pigeonhole prune: fewer free positions than remaining requirements.
    let free = 0;
    for (let u = 0; u < used.length; u++) if (!used[u]) free++;
    if (reqs.length - i > free) return false;
    for (let pos = lo; pos <= hi; pos++) {
      if (used[pos - lo]) continue;
      if (!events[pos]!.keywords.includes(reqs[i]!.keyword)) continue;
      let ok = true;
      for (const p of reqs[i]!.prereqs ?? []) {
        if (assign[p]! !== -1 && pos <= assign[p]!) {
          ok = false;
          break;
        }
      }
      if (!ok) continue;
      assign[i] = pos;
      used[pos - lo] = true;
      if (dfs(i + 1)) return true;
      used[pos - lo] = false;
      assign[i] = -1;
    }
    return false;
  }

  return dfs(0);
}

/**
 * Builds the requirement-count certificate by exhaustively enumerating all
 * O(n^2) contiguous intervals and testing each with the independent oracle.
 */
export function enumerateCertificate(
  events: readonly LogEvent[],
  reqs: readonly Requirement[],
): CountCertificate {
  const n = events.length;
  let minLength: number | null = null;
  let count = 0;
  let earliestStart: number | null = null;
  for (let lo = 0; lo < n; lo++) {
    for (let hi = lo; hi < n; hi++) {
      const length = hi - lo + 1;
      if (minLength !== null && length > minLength) break;
      if (!matchingExistsIndependent(events, lo, hi, reqs)) continue;
      if (minLength === null || length < minLength) {
        minLength = length;
        count = 1;
        earliestStart = lo;
      } else {
        count++;
      }
    }
  }
  return {
    feasible: minLength !== null,
    requirementCount: reqs.length,
    satisfiedCount: minLength !== null ? reqs.length : 0,
    minLength,
    minLengthIntervalCount: count,
    earliestStartAtMinLength: earliestStart,
  };
}

/**
 * Re-validates a one-to-one matching certificate (requirement -> event id)
 * against the event list and the segment bounds. Returns null when valid.
 */
export function validateMatchingCertificate(
  events: readonly LogEvent[],
  lo: number,
  hi: number,
  reqs: readonly Requirement[],
  matching: readonly MatchingEntry[],
): string | null {
  if (matching.length !== reqs.length) {
    return `certificate covers ${matching.length} requirements, expected ${reqs.length}`;
  }
  const positionById = new Map<string, number>();
  for (let i = 0; i < events.length; i++) positionById.set(events[i]!.id, i);
  const seenReqs = new Set<number>();
  const positions: number[] = new Array<number>(reqs.length).fill(-1);
  for (const entry of matching) {
    if (seenReqs.has(entry.requirement)) {
      return `requirement ${entry.requirement} matched twice`;
    }
    seenReqs.add(entry.requirement);
    const pos = positionById.get(entry.eventId);
    if (pos === undefined) return `unknown event id "${entry.eventId}"`;
    positions[entry.requirement] = pos;
  }
  for (let i = 0; i < reqs.length; i++) {
    if (!seenReqs.has(i)) return `requirement ${i} has no matched event`;
  }
  const seenPos = new Set<number>();
  for (let i = 0; i < reqs.length; i++) {
    const pos = positions[i]!;
    if (pos < lo || pos > hi) {
      return `requirement ${i} matched outside the segment`;
    }
    if (seenPos.has(pos)) {
      return `event "${events[pos]!.id}" satisfies more than one requirement`;
    }
    seenPos.add(pos);
    if (!events[pos]!.keywords.includes(reqs[i]!.keyword)) {
      return `event "${events[pos]!.id}" lacks keyword "${reqs[i]!.keyword}"`;
    }
  }
  for (let i = 0; i < reqs.length; i++) {
    for (const p of reqs[i]!.prereqs ?? []) {
      if (positions[i]! <= positions[p]!) {
        return `requirement ${i} is not matched after prerequisite ${p}`;
      }
    }
  }
  const groupSources = new Map<string, Set<string>>();
  for (let i = 0; i < reqs.length; i++) {
    const group = reqs[i]!.mutexGroup;
    if (group === undefined) continue;
    const source = events[positions[i]!]!.source;
    let sources = groupSources.get(group);
    if (sources === undefined) {
      sources = new Set();
      groupSources.set(group, sources);
    }
    if (sources.has(source)) {
      return `mutex group "${group}" reuses source "${source}"`;
    }
    sources.add(source);
  }
  return null;
}

/**
 * Cross-checks a search result against an exhaustive re-enumeration of all
 * intervals plus a full re-validation of the matching certificate.
 */
export function verifyResult(
  events: readonly LogEvent[],
  reqs: readonly Requirement[],
  result: SearchResult | null,
): VerificationReport {
  const checks: VerificationCheck[] = [];
  const cert = enumerateCertificate(events, reqs);

  if (result === null) {
    checks.push({
      name: "infeasible-confirmed-by-enumeration",
      ok: !cert.feasible,
      detail: cert.feasible
        ? `enumeration found a feasible segment of length ${cert.minLength}`
        : undefined,
    });
    return { ok: checks.every((c) => c.ok), checks };
  }

  const matchingProblem = validateMatchingCertificate(
    events,
    result.start,
    result.end,
    reqs,
    result.matching,
  );
  checks.push({
    name: "matching-certificate-valid",
    ok: matchingProblem === null,
    detail: matchingProblem ?? undefined,
  });

  checks.push({
    name: "length-matches-enumerated-minimum",
    ok: cert.minLength !== null && result.length === cert.minLength,
    detail:
      cert.minLength === null
        ? "enumeration found no feasible segment"
        : result.length === cert.minLength
          ? undefined
          : `reported ${result.length}, enumerated minimum ${cert.minLength}`,
  });

  checks.push({
    name: "earliest-start-among-ties",
    ok: cert.earliestStartAtMinLength !== null && result.start === cert.earliestStartAtMinLength,
    detail:
      cert.earliestStartAtMinLength !== null && result.start !== cert.earliestStartAtMinLength
        ? `reported start ${result.start}, earliest is ${cert.earliestStartAtMinLength}`
        : undefined,
  });

  checks.push({
    name: "bounds-consistent",
    ok:
      result.start >= 0 &&
      result.end < events.length &&
      result.end - result.start + 1 === result.length,
  });

  return { ok: checks.every((c) => c.ok), checks };
}
