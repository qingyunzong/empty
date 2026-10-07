import { createHash } from "node:crypto";

export const RULE_VERSION = "clearing-v1";

export function sha256(text) {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

// Canonical certificate for a closed window. The contributing entries are
// sorted so the certificate is independent of event arrival order and can be
// recomputed by any verifier holding the same effective postings.
export function windowCert(winStart, winEnd, mch, entries) {
  const canon = entries
    .map((e) => `${e.id}:${e.kind}:${e.amt}`)
    .sort()
    .join(",");
  return sha256(`${RULE_VERSION}|${winStart}|${winEnd}|${mch}|${canon}`);
}

// Certificate for a correction record produced by a void that arrived after
// the target window was closed.
export function correctionCert(winStart, winEnd, mch, id, amt) {
  return sha256(`${RULE_VERSION}|correction|${winStart}|${winEnd}|${mch}|${id}:${amt}`);
}
