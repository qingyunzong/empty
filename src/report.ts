import type { Evidence, FinalState, RoundView, Runtime } from "./runtime.js";

export function formatEvidence(evidence: Evidence): string {
  const message = evidence.message;
  const seq = String(evidence.arrivalSeq).padStart(3, "0");
  const disposition = evidence.disposition.padEnd(8);
  return (
    `#${seq} [${disposition}] ${message.slot}#gen${message.generation} ` +
    `${message.type.padEnd(6)} emit=${message.emitSeq} ` +
    `payload=${JSON.stringify(message.payload)} -- ${evidence.reason}`
  );
}

export function formatFinalState(view: RoundView): string {
  const header = `${view.slot}#gen${view.generation}`;
  if (!view.finalState) return `${header}: ${view.phase} (no final state yet)`;
  const state: FinalState = view.finalState;
  const lateCount = view.evidence.filter((e) => e.disposition === "late").length;
  const parts = [
    `${header}: ${state.status}`,
    `exit=${state.exitCode === null ? "none" : state.exitCode}`,
    `stdout=${JSON.stringify(state.stdout)}`,
    `asserts=${JSON.stringify(state.assertions)}`,
  ];
  if (state.status === "closed-truncated") {
    parts.push(`truncatedBytes=${state.truncatedBytes}`);
    parts.push(`reason=${JSON.stringify(state.truncateReason)}`);
  }
  parts.push(`lateEvidence=${lateCount}`);
  return parts.join(" ");
}

export function buildReport(runtime: Runtime): string {
  const lines: string[] = [];
  lines.push("== Evidence log (global arrival order) ==");
  for (const evidence of runtime.log) {
    lines.push(formatEvidence(evidence));
  }
  lines.push("");
  lines.push("== Unique round final states (immutable after close) ==");
  for (const view of runtime.listRounds()) {
    lines.push(formatFinalState(view));
  }
  return lines.join("\n");
}
