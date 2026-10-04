import { existsSync, readFileSync } from "node:fs";

interface RawRecord {
  type?: string;
  txnId?: string;
  [key: string]: unknown;
}

export interface CheckerInput {
  coordinatorLog: string;
  participantLogs: Record<string, string>;
}

export interface CheckerReport {
  ok: boolean;
  violations: string[];
}

/** Independent JSONL reader: the checker shares no code path or state
 *  with the coordinator/participant implementations. */
function readJsonl(file: string): RawRecord[] {
  if (!existsSync(file)) return [];
  return readFileSync(file, "utf8")
    .split("\n")
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line) as RawRecord);
}

function uniq(values: unknown[]): unknown[] {
  return [...new Set(values)];
}

/**
 * Independent state checker. Reads only the files on disk and verifies,
 * per transaction:
 *   1. each participant persisted at most one vote and one decision;
 *   2. AGREEMENT: every decided participant reached the same decision;
 *   3. any participant decision matches the coordinator's decision record;
 *   4. no participant committed without a coordinator COMMIT record;
 *   5. COMMIT requires a YES vote from every participant;
 *   6. if the coordinator logged END, every participant holds the decision.
 * Undecided (in-doubt) participants are legal; fabricated divergence is not.
 */
export function check(input: CheckerInput): CheckerReport {
  const violations: string[] = [];
  const coord = readJsonl(input.coordinatorLog);
  const parts = new Map(
    Object.entries(input.participantLogs).map(([id, file]) => [id, readJsonl(file)] as const),
  );

  const txnIds = new Set<string>();
  for (const r of coord) if (typeof r.txnId === "string") txnIds.add(r.txnId);
  for (const records of parts.values()) {
    for (const r of records) if (typeof r.txnId === "string") txnIds.add(r.txnId);
  }

  for (const txnId of [...txnIds].sort()) {
    const tag = "txn " + txnId + ":";
    const cRecs = coord.filter((r) => r.txnId === txnId);

    const cDecisions = uniq(cRecs.filter((r) => r.type === "DECISION").map((r) => r.decision));
    if (cDecisions.length > 1) {
      violations.push(tag + " coordinator logged conflicting decisions " + cDecisions.join(","));
    }
    const cDecision = cDecisions[0] as string | undefined;
    const ended = cRecs.some((r) => r.type === "END");

    const pDecisions = new Map<string, string>();
    const pVotes = new Map<string, string>();
    for (const [pid, records] of parts) {
      const mine = records.filter((r) => r.txnId === txnId);
      const votes = uniq(mine.filter((r) => r.type === "VOTE").map((r) => r.vote));
      if (votes.length > 1) {
        violations.push(tag + " participant " + pid + " logged conflicting votes");
      }
      if (votes.length === 1) pVotes.set(pid, votes[0] as string);
      const decisions = uniq(mine.filter((r) => r.type === "DECISION").map((r) => r.decision));
      if (decisions.length > 1) {
        violations.push(tag + " participant " + pid + " logged conflicting decisions");
      }
      if (decisions.length === 1) pDecisions.set(pid, decisions[0] as string);
    }

    // Agreement across participants.
    const distinct = uniq([...pDecisions.values()]);
    if (distinct.length > 1) {
      violations.push(
        tag + " participants disagree: " +
        [...pDecisions.entries()].map(([p, d]) => p + "=" + d).join(", "),
      );
    }

    // Participant decisions must match the coordinator's record.
    if (cDecision !== undefined) {
      for (const [pid, d] of pDecisions) {
        if (d !== cDecision) {
          violations.push(
            tag + " participant " + pid + " decided " + d +
            " but coordinator recorded " + cDecision,
          );
        }
      }
    }

    // A commit anywhere requires a coordinator COMMIT record.
    if ([...pDecisions.values()].includes("COMMIT") && cDecision !== "COMMIT") {
      violations.push(tag + " participant committed without a coordinator COMMIT record");
    }

    // Commit requires a YES vote from every participant.
    if (cDecision === "COMMIT" || [...pDecisions.values()].includes("COMMIT")) {
      for (const pid of parts.keys()) {
        if (pVotes.get(pid) !== "YES") {
          violations.push(
            tag + " COMMIT requires YES from all, but " + pid +
            " voted " + (pVotes.get(pid) ?? "(no vote)"),
          );
        }
      }
    }

    // Termination: END means the decision reached every participant.
    if (ended && cDecision !== undefined) {
      for (const pid of parts.keys()) {
        if (pDecisions.get(pid) !== cDecision) {
          violations.push(
            tag + " coordinator logged END but participant " + pid +
            " has decision " + (pDecisions.get(pid) ?? "(none)"),
          );
        }
      }
    }
  }

  return { ok: violations.length === 0, violations };
}
