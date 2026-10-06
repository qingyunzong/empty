import { canonicalize } from "./canonical.js";
import { digestContent, digestValue, sha256Hex } from "./digest.js";
import type { Evidence, Plan, Resource, VerifyResult } from "./types.js";

/**
 * Pure re-verification of a plan and its evidence against the given
 * resources. Recomputes every digest and hash from scratch; tampering
 * with any single field (content, digest, action, order, evidence)
 * yields { ok: false }. Performs no I/O and no side effects.
 */
export function verifyPlan(
  plan: Plan,
  evidence: Evidence,
  resources: Resource[],
): VerifyResult {
  if (plan.planId !== evidence.planId) {
    return { ok: false, reason: "plan/evidence planId mismatch" };
  }

  // Resource digests must match both the evidence and the live content.
  const evidenceIds = Object.keys(evidence.resourceDigests).sort();
  const liveIds = resources.map((r) => r.id).sort();
  if (canonicalize(evidenceIds) !== canonicalize(liveIds)) {
    return { ok: false, reason: "resource set does not match evidence" };
  }
  for (const resource of resources) {
    if (digestContent(resource.content) !== resource.digest) {
      return { ok: false, reason: `resource "${resource.id}" content does not match its digest` };
    }
    if (evidence.resourceDigests[resource.id] !== resource.digest) {
      return { ok: false, reason: `resource "${resource.id}" digest does not match evidence` };
    }
  }

  // Every action input must resolve to a verified resource.
  const known = new Set(resources.map((r) => r.id));
  for (const step of plan.steps) {
    for (const input of step.action.inputs) {
      if (!known.has(input)) {
        return { ok: false, reason: `step ${step.seq} references unknown resource "${input}"` };
      }
    }
  }

  // Recompute the ordered hash chain.
  let previousChain = "sha256:" + "0".repeat(64);
  for (let seq = 0; seq < plan.steps.length; seq += 1) {
    const step = plan.steps[seq]!;
    if (step.seq !== seq) {
      return { ok: false, reason: `step order broken at position ${seq}` };
    }
    const stepHash = digestValue({ seq, action: step.action });
    if (step.stepHash !== stepHash || evidence.stepHashes[seq] !== stepHash) {
      return { ok: false, reason: `step ${seq} hash mismatch` };
    }
    const chainHash = "sha256:" + sha256Hex(previousChain + "|" + stepHash);
    if (step.chainHash !== chainHash) {
      return { ok: false, reason: `step ${seq} chain hash mismatch` };
    }
    previousChain = chainHash;
  }
  if (evidence.stepHashes.length !== plan.steps.length) {
    return { ok: false, reason: "evidence step count mismatch" };
  }
  if (evidence.finalChainHash !== previousChain) {
    return { ok: false, reason: "final chain hash mismatch" };
  }

  // Root hash binds plan id, resource digests, and the whole chain.
  const rootHash = digestValue({
    planId: evidence.planId,
    resourceDigests: evidence.resourceDigests,
    stepHashes: evidence.stepHashes,
    finalChainHash: evidence.finalChainHash,
  });
  if (evidence.rootHash !== rootHash) {
    return { ok: false, reason: "evidence root hash mismatch" };
  }

  return { ok: true };
}
