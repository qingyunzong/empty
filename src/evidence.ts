import type { EventKind } from "./events.ts";

/**
 * Decision evidence. Every dispatched event produces exactly one record
 * explaining what was decided and why, so outcomes can be audited and
 * reconciled against the reference event model.
 */
export interface Evidence {
  tick: number;
  seq: number;
  kind: EventKind;
  decision: "accepted" | "rejected";
  /** Machine-checkable rule code, e.g. PERMISSION_REVOKED, STALE_VERSION. */
  rule: string;
  /** Permission ledger version after this event was applied. */
  permissionVersion: number;
  /** Permission version bound to the batch, when relevant. */
  boundVersion?: number;
  /** Permission state observed while deciding, when relevant. */
  granted?: boolean;
  detail: string;
}

export function formatEvidence(e: Evidence): string {
  const parts = [
    `t${e.tick}#${e.seq}`,
    e.kind,
    e.decision.toUpperCase(),
    e.rule,
    `pv=${e.permissionVersion}`,
  ];
  if (e.boundVersion !== undefined) parts.push(`bv=${e.boundVersion}`);
  if (e.granted !== undefined) parts.push(`granted=${e.granted}`);
  return `${parts.join(" ")} :: ${e.detail}`;
}
