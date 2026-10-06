import { Allocation, Market } from "./model";

/**
 * Applicant-proposing deferred acceptance for capacity-only markets
 * (no category quotas). Preferences are strict after id tie-breaking.
 * Produces the applicant-optimal stable allocation.
 */
export function deferredAcceptance(market: Market): Allocation {
  if (market.hasQuotas) {
    throw new Error("deferred acceptance supports capacity-only markets; use solve() for quota markets");
  }
  const assignment = new Map<string, string>();
  const holds = new Map<string, string[]>(market.institutions.map((i) => [i.id, []]));
  const nextIndex = new Map<string, number>(market.applicants.map((a) => [a.id, 0]));
  const free = market.applicants.map((a) => a.id);

  while (free.length > 0) {
    const applicantId = free.shift()!;
    const applicant = market.applicantById.get(applicantId)!;
    const idx = nextIndex.get(applicantId)!;
    if (idx >= applicant.strictPrefs.length) continue; // exhausted list: stays unassigned
    nextIndex.set(applicantId, idx + 1);
    const inst = market.institutionById.get(applicant.strictPrefs[idx]!)!;
    if (!inst.rankOf.has(applicantId)) {
      free.push(applicantId); // unacceptable to institution: rejected
      continue;
    }
    const held = holds.get(inst.id)!;
    if (held.length < inst.capacity) {
      held.push(applicantId);
      assignment.set(applicantId, inst.id);
      continue;
    }
    let worst = held[0]!;
    for (const h of held) {
      if (inst.rankOf.get(h)! > inst.rankOf.get(worst)!) worst = h;
    }
    if (inst.rankOf.get(applicantId)! < inst.rankOf.get(worst)!) {
      held.splice(held.indexOf(worst), 1);
      held.push(applicantId);
      assignment.set(applicantId, inst.id);
      assignment.delete(worst);
      free.push(worst);
    } else {
      free.push(applicantId);
    }
  }
  return assignment;
}
