import { EvidenceLog } from "./evidence.js";
import { Runtime } from "./runtime.js";

export interface RoundSummary {
  readonly roundId: string;
  readonly generation: number;
  readonly terminalState: string;
  readonly reason: string;
  readonly stdoutChunks: number;
  readonly assertions: number;
  readonly exitCode: number | null;
  readonly lateMessageIds: readonly string[];
}

export interface SimulationResult {
  readonly evidence: EvidenceLog;
  readonly runtime: Runtime;
  readonly summaries: RoundSummary[];
  readonly report: string;
}

/**
 * Deterministic out-of-order scenario (seeded shuffle):
 *
 *  - round-1 emits stdout chunks, assertions and an exit message, then
 *    `endRound()` is called BEFORE the transport delivers everything:
 *    the round enters `closing` and must wait for drain.
 *  - Only part of the queue is delivered; the round stays `closing`
 *    until `truncate()` explicitly terminates it.
 *  - The stale gen-1 handle then tries to write — rejected, and the
 *    write must not leak into round-2.
 *  - round-2 runs; all remaining messages (including round-1's late
 *    stdout/assertion/exit) are delivered interleaved. Late messages
 *    are attributed to round-1 as evidence only.
 *  - A duplicate truncation attempt proves the terminal state is unique.
 */
export function runSimulation(seed = 42): SimulationResult {
  const runtime = new Runtime();

  // ---- round 1 (generation 1) ----
  const h1 = runtime.beginRound();
  h1.writeStdout("r1-out-0 ");
  h1.writeStdout("r1-out-1 ");
  h1.writeStdout("r1-out-final\n", true);
  h1.assert("r1: adds numbers", true);
  h1.assert("r1: schema valid", false, "missing field 'id'");
  h1.exit(0);

  runtime.endRound(); // -> closing; must wait for drain or truncation
  runtime.transport.shuffle(seed); // deterministic out-of-order delivery
  runtime.transport.deliver(2, (m) => runtime.receive(m)); // partial drain
  runtime.truncate("deadline exceeded while waiting for stream drain");

  // ---- round 2 (generation 2) ----
  const h2 = runtime.beginRound();

  // Stale gen-1 handle must not write into the new generation.
  h1.writeStdout("STALE-WRITE", true);
  h1.assert("r1: late direct assert", true);

  h2.writeStdout("r2-out-0 ");
  h2.writeStdout("r2-out-final\n", true);
  h2.assert("r2: boots", true);
  h2.exit(0);
  runtime.endRound(); // -> closing; will complete once drained

  // Everything still queued (round-1 late messages + round-2 messages)
  // arrives interleaved, after round-1 is already terminal.
  runtime.transport.deliverAll((m) => runtime.receive(m));

  // Uniqueness guard: round-2 is already 'completed'.
  runtime.truncate("second termination attempt");

  // A message for a round that never existed.
  runtime.receive({
    kind: "stdout",
    messageId: "r99:stdout:1",
    roundId: "round-99",
    generation: 99,
    seq: 1,
    chunk: "ghost",
    final: true,
  });

  const summaries: RoundSummary[] = runtime.allRounds().map((r) => ({
    roundId: r.id,
    generation: r.generation,
    terminalState: r.terminalState ?? "NONE",
    reason: r.terminalReason ?? "-",
    stdoutChunks: r.stdout.length,
    assertions: r.assertions.length,
    exitCode: r.exit ? r.exit.code : null,
    lateMessageIds: r.lateMessageIds,
  }));

  const report = formatReport(runtime.evidence, summaries);
  return { evidence: runtime.evidence, runtime, summaries, report };
}

function formatReport(evidence: EvidenceLog, summaries: RoundSummary[]): string {
  const lines: string[] = [];
  lines.push("=== Citation evidence (complete, in recording order) ===");
  lines.push(evidence.format());
  lines.push("");
  lines.push("=== Unique terminal state per round ===");
  for (const s of summaries) {
    lines.push(
      `${s.roundId} (gen ${s.generation}): ${s.terminalState.toUpperCase()} — ${s.reason}\n` +
        `    applied: stdout chunks=${s.stdoutChunks}, assertions=${s.assertions}, exit code=${s.exitCode ?? "none"}\n` +
        `    late messages filed on this round: [${s.lateMessageIds.join(", ") || "none"}]`,
    );
  }
  return lines.join("\n");
}

// Run directly: `node dist/src/simulate.js`
if (import.meta.url === `file://${process.argv[1]}`) {
  console.log(runSimulation().report);
}
