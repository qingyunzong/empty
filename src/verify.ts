import { bruteForceMatching, validateRequirements } from "./matching.js";
import type {
  LogEvent,
  Requirement,
  SearchCertificate,
  VerificationReport,
} from "./types.js";

/**
 * Independent legality check of a one-to-one matching certificate:
 * distinct events, inside the window, keyword present, dependency order
 * respected, mutex-group sources pairwise distinct.
 */
export function checkMatchingLegality(
  events: readonly LogEvent[],
  reqs: readonly Requirement[],
  cert: SearchCertificate,
): string[] {
  const errors: string[] = [];
  const m = cert.matching;
  if (m.length !== reqs.length) {
    errors.push(
      `matching covers ${m.length} of ${reqs.length} requirement slots`,
    );
  }
  const seenReq = new Set<number>();
  const seenEvt = new Set<number>();
  const byReq = new Map<number, number>();
  for (const entry of m) {
    if (seenReq.has(entry.requirement)) {
      errors.push(`requirement ${entry.requirement} matched more than once`);
    }
    seenReq.add(entry.requirement);
    if (seenEvt.has(entry.event)) {
      errors.push(
        `event index ${entry.event} satisfies more than one requirement slot`,
      );
    }
    seenEvt.add(entry.event);
    if (entry.event < cert.lo || entry.event > cert.hi) {
      errors.push(
        `event index ${entry.event} lies outside the segment [${cert.lo}, ${cert.hi}]`,
      );
    }
    const ev = events[entry.event];
    if (ev === undefined) {
      errors.push(`event index ${entry.event} out of range`);
      continue;
    }
    if (ev.id !== entry.eventId) {
      errors.push(
        `certificate event id "${entry.eventId}" does not match event ${entry.event} ("${ev.id}")`,
      );
    }
    if (!ev.keywords.includes(entry.keyword)) {
      errors.push(
        `event "${ev.id}" does not contain keyword "${entry.keyword}"`,
      );
    }
    byReq.set(entry.requirement, entry.event);
  }
  for (let r = 0; r < reqs.length; r++) {
    const er = byReq.get(r);
    if (er === undefined) {
      errors.push(`requirement ${r} is unmatched`);
      continue;
    }
    for (const d of reqs[r]!.dependsOn ?? []) {
      const ed = byReq.get(d);
      if (ed !== undefined && ed >= er) {
        errors.push(
          `dependency violated: requirement ${d} (event ${ed}) must be matched strictly before requirement ${r} (event ${er})`,
        );
      }
    }
  }
  const groups = new Map<string, Map<string, number>>();
  for (const [r, e] of byReq) {
    const g = reqs[r]!.mutexGroup;
    if (g === undefined) continue;
    const src = events[e]!.source;
    const seen = groups.get(g) ?? new Map<string, number>();
    if (seen.has(src)) {
      errors.push(
        `source "${src}" reused inside mutex group "${g}" by requirements ${seen.get(src)} and ${r}`,
      );
    }
    seen.set(src, r);
    groups.set(g, seen);
  }
  return errors;
}

/**
 * Independent verification: re-derives the answer by enumerating every
 * contiguous interval with the naive matcher, then checks the certificate
 * for legality, minimality and the earliest-start tie-break.
 */
export function verifyCertificate(
  events: readonly LogEvent[],
  reqs: readonly Requirement[],
  cert: SearchCertificate | null,
): VerificationReport {
  validateRequirements(reqs);
  const errors: string[] = [];
  const n = events.length;

  // Full enumeration of all intervals with the independent matcher.
  let bestLen = Number.POSITIVE_INFINITY;
  let bestLo = -1;
  let bestHi = -1;
  for (let i = 0; i < n; i++) {
    for (let j = i; j < n; j++) {
      if (j - i + 1 >= bestLen) break; // cannot improve the recorded optimum
      if (bruteForceMatching(events, reqs, i, j) === null) continue;
      bestLen = j - i + 1;
      bestLo = i;
      bestHi = j;
      break; // minimal right endpoint for this left endpoint
    }
  }

  let matchingLegal = true;
  let countCertificateOk = true;
  let minimal: boolean;
  let tieBreakOk: boolean;

  if (cert === null) {
    minimal = bestLen === Number.POSITIVE_INFINITY;
    tieBreakOk = minimal;
    if (!minimal) {
      errors.push(
        `solver reported no segment, but enumeration found one of length ${bestLen} at [${bestLo}, ${bestHi}]`,
      );
    }
  } else {
    if (cert.length !== cert.hi - cert.lo + 1) {
      errors.push(
        `certificate length ${cert.length} inconsistent with [${cert.lo}, ${cert.hi}]`,
      );
      countCertificateOk = false;
    }
    if (cert.requirementCount !== reqs.length) {
      errors.push(
        `certificate requirement count ${cert.requirementCount} != ${reqs.length}`,
      );
      countCertificateOk = false;
    }
    const legalErrors = checkMatchingLegality(events, reqs, cert);
    if (legalErrors.length > 0) {
      matchingLegal = false;
      errors.push(...legalErrors);
    }
    minimal = cert.length === bestLen;
    if (!minimal) {
      errors.push(
        `certificate length ${cert.length} is not optimal (optimum is ${bestLen})`,
      );
    }
    tieBreakOk = cert.lo === bestLo && cert.hi === bestHi;
    if (!tieBreakOk) {
      errors.push(
        `tie-break violated: expected earliest segment [${bestLo}, ${bestHi}], got [${cert.lo}, ${cert.hi}]`,
      );
    }
  }

  return {
    ok: errors.length === 0,
    matchingLegal,
    countCertificateOk,
    minimal,
    tieBreakOk,
    errors,
  };
}
