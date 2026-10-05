import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { CoordinatorRecord, ParticipantRecord } from "./types.js";

export interface CheckResult {
  violations: string[];
  /** Transactions with no durable decision yet (blocked, not inconsistent). */
  pending: string[];
}

function readJsonLines<T>(file: string): T[] {
  if (!existsSync(file)) return [];
  return readFileSync(file, "utf8")
    .split("\n")
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line) as T);
}

/**
 * Independent state checker. It reads every log file in a run directory
 * directly from disk (never through the node implementations) and verifies
 * that all participants and the coordinator agree on every transaction.
 *
 * When `requireQuiescent` is true, every begun transaction must additionally
 * be fully decided and delivered everywhere (used after a run completes).
 */
export function check(dir: string, requireQuiescent = false): CheckResult {
  const violations: string[] = [];
  const pending: string[] = [];

  const coordinatorLog = readJsonLines<CoordinatorRecord>(join(dir, "coordinator.log"));
  const participantFiles = readdirSync(dir)
    .filter((name) => /^participant-.+\.log$/.test(name))
    .sort();
  const participantLogs = new Map<string, ParticipantRecord[]>();
  for (const file of participantFiles) {
    participantLogs.set(file, readJsonLines<ParticipantRecord>(join(dir, file)));
  }

  // Coordinator-side invariants.
  const begins = new Map<string, string[]>();
  const votes = new Map<string, Map<string, "YES" | "NO">>();
  const decisions = new Map<string, "COMMIT" | "ABORT">();
  for (const record of coordinatorLog) {
    switch (record.kind) {
      case "BEGIN":
        if (begins.has(record.txId)) violations.push(`duplicate BEGIN for ${record.txId}`);
        begins.set(record.txId, record.participants);
        break;
      case "VOTE": {
        if (!begins.has(record.txId)) {
          violations.push(`VOTE for ${record.txId} before BEGIN`);
          break;
        }
        let txVotes = votes.get(record.txId);
        if (!txVotes) votes.set(record.txId, (txVotes = new Map()));
        const prior = txVotes.get(record.from);
        if (prior && prior !== record.vote) {
          violations.push(`conflicting votes from ${record.from} for ${record.txId}`);
        }
        txVotes.set(record.from, record.vote);
        break;
      }
      case "DECISION": {
        if (decisions.has(record.txId)) {
          violations.push(`duplicate DECISION for ${record.txId}`);
          break;
        }
        decisions.set(record.txId, record.decision);
        const txVotes = votes.get(record.txId) ?? new Map<string, "YES" | "NO">();
        if (record.decision === "ABORT") {
          const hasNo = [...txVotes.values()].includes("NO");
          if (!hasNo) {
            violations.push(`fabricated rollback: DECISION ABORT for ${record.txId} without a recorded NO vote`);
          }
        } else {
          const roster = begins.get(record.txId) ?? [];
          for (const participant of roster) {
            if (txVotes.get(participant) !== "YES") {
              violations.push(`DECISION COMMIT for ${record.txId} without recorded YES from ${participant}`);
            }
          }
        }
        break;
      }
    }
  }

  // Participant-side and cross-node invariants.
  const outcomes = new Map<string, Map<string, "COMMITTED" | "ABORTED">>();
  for (const [file, records] of participantLogs) {
    const prepared = new Set<string>();
    const final = new Map<string, "COMMITTED" | "ABORTED">();
    for (const record of records) {
      switch (record.kind) {
        case "PREPARED":
          if (final.has(record.txId)) {
            violations.push(`${file}: PREPARED for ${record.txId} after final state`);
          }
          prepared.add(record.txId);
          break;
        case "COMMITTED": {
          if (!prepared.has(record.txId)) {
            violations.push(`${file}: COMMITTED ${record.txId} without prior PREPARED`);
          }
          if (final.has(record.txId)) {
            violations.push(`${file}: ${record.txId} decided twice`);
          }
          final.set(record.txId, "COMMITTED");
          if (decisions.get(record.txId) !== "COMMIT") {
            violations.push(`${file}: COMMITTED ${record.txId} but coordinator has no DECISION COMMIT`);
          }
          break;
        }
        case "ABORTED": {
          if (final.has(record.txId)) {
            violations.push(`${file}: ${record.txId} decided twice`);
          }
          final.set(record.txId, "ABORTED");
          if (record.cause === "DECISION" && decisions.get(record.txId) !== "ABORT") {
            violations.push(`${file}: ABORTED ${record.txId} by decision but coordinator has no DECISION ABORT`);
          }
          break;
        }
      }
    }
    for (const [txId, outcome] of final) {
      let perTx = outcomes.get(txId);
      if (!perTx) outcomes.set(txId, (perTx = new Map()));
      perTx.set(file, outcome);
    }
  }

  // Global agreement: no two participants may reach different outcomes.
  for (const [txId, perParticipant] of outcomes) {
    const distinct = new Set(perParticipant.values());
    if (distinct.size > 1) {
      violations.push(`divergent outcomes for ${txId}: ${JSON.stringify([...perParticipant.entries()])}`);
    }
  }

  if (requireQuiescent) {
    for (const [txId, roster] of begins) {
      const decision = decisions.get(txId);
      if (!decision) {
        violations.push(`tx ${txId} has BEGIN but no DECISION after completion`);
        continue;
      }
      const expected = decision === "COMMIT" ? "COMMITTED" : "ABORTED";
      for (const participant of roster) {
        const file = `participant-${participant}.log`;
        const outcome = outcomes.get(txId)?.get(file);
        if (outcome !== expected) {
          violations.push(`tx ${txId}: ${file} is ${outcome ?? "undecided"}, expected ${expected}`);
        }
      }
    }
  } else {
    for (const txId of begins.keys()) {
      if (!decisions.has(txId)) pending.push(txId);
    }
  }

  return { violations, pending };
}
