import { EvidenceLog } from "./evidence.js";
import type { RoundMessage } from "./messages.js";
import { Transport } from "./transport.js";

export type RoundPhase = "open" | "closing" | "completed" | "truncated";
export type TerminalState = "completed" | "truncated";

export interface StdoutChunkRecord {
  readonly seq: number;
  readonly chunk: string;
  readonly final: boolean;
  readonly messageId: string;
}

export interface AssertionRecord {
  readonly seq: number;
  readonly name: string;
  readonly passed: boolean;
  readonly detail?: string;
  readonly messageId: string;
}

export interface ExitRecord {
  readonly code: number;
  readonly signal: string | null;
  readonly messageId: string;
}

/**
 * One generation of runtime work. State is mutated only while the round
 * is non-terminal; after termination, late messages are filed as
 * evidence on this round without touching its results.
 */
export class Round {
  readonly id: string;
  readonly generation: number;
  phase: RoundPhase = "open";
  terminalState: TerminalState | null = null;
  terminalReason: string | null = null;

  readonly stdout: StdoutChunkRecord[] = [];
  stdoutDrained = false;
  readonly assertions: AssertionRecord[] = [];
  exit: ExitRecord | null = null;

  /** Message ids that arrived after this round went terminal. */
  readonly lateMessageIds: string[] = [];

  constructor(generation: number) {
    this.generation = generation;
    this.id = `round-${generation}`;
  }

  get isTerminal(): boolean {
    return this.terminalState !== null;
  }

  /** Drain condition: final stdout chunk seen AND exit message seen. */
  get drained(): boolean {
    return this.stdoutDrained && this.exit !== null;
  }
}

/**
 * Generation-scoped writer. A handle can only emit messages while its
 * own round is open; once the round closes, the handle is stale and its
 * writes are rejected — they can never leak into a newer round.
 */
export class RoundHandle {
  private seq = 0;

  constructor(
    private readonly runtime: Runtime,
    readonly round: Round,
  ) {}

  get generation(): number {
    return this.round.generation;
  }

  get stale(): boolean {
    return this.round.phase !== "open";
  }

  private emit(kind: RoundMessage["kind"], build: (seq: number) => RoundMessage): string | null {
    if (this.stale) {
      const current = this.runtime.current;
      this.runtime.evidence.record({
        roundId: this.round.id,
        generation: this.round.generation,
        messageId: null,
        event: "write",
        disposition: "rejected-stale-handle",
        detail:
          `stale gen-${this.round.generation} handle tried to emit ${kind}; ` +
          `round is ${this.round.phase}; rejected — not attributed to ` +
          (current ? `${current.id} (gen ${current.generation})` : "any round"),
      });
      return null;
    }
    const seq = ++this.seq;
    const message = build(seq);
    this.runtime.transport.send(message);
    return message.messageId;
  }

  writeStdout(chunk: string, final = false): string | null {
    return this.emit("stdout", (seq) => ({
      kind: "stdout",
      messageId: `r${this.generation}:stdout:${seq}`,
      roundId: this.round.id,
      generation: this.generation,
      seq,
      chunk,
      final,
    }));
  }

  assert(name: string, passed: boolean, detail?: string): string | null {
    return this.emit("assertion", (seq) => ({
      kind: "assertion",
      messageId: `r${this.generation}:assertion:${seq}`,
      roundId: this.round.id,
      generation: this.generation,
      seq,
      name,
      passed,
      detail,
    }));
  }

  exit(code: number, signal: string | null = null): string | null {
    return this.emit("exit", (seq) => ({
      kind: "exit",
      messageId: `r${this.generation}:exit:${seq}`,
      roundId: this.round.id,
      generation: this.generation,
      seq,
      code,
      signal,
    }));
  }
}

export class Runtime {
  readonly evidence = new EvidenceLog();
  readonly transport = new Transport();

  private readonly rounds = new Map<string, Round>();
  private readonly order: Round[] = [];
  current: Round | null = null;

  /** Open a new generation. Requires the previous round to be terminal. */
  beginRound(): RoundHandle {
    if (this.current && !this.current.isTerminal) {
      throw new Error(
        `cannot begin a new round: ${this.current.id} is still ${this.current.phase} ` +
          `(end it and wait for drain, or truncate it)`,
      );
    }
    const round = new Round(this.order.length + 1);
    this.rounds.set(round.id, round);
    this.order.push(round);
    this.current = round;
    this.evidence.record({
      roundId: round.id,
      generation: round.generation,
      messageId: null,
      event: "lifecycle",
      disposition: "state-transition",
      detail: `round opened (generation ${round.generation})`,
    });
    return new RoundHandle(this, round);
  }

  /**
   * Begin ending the current round: it enters `closing` and completes
   * only once its streams have drained (final stdout chunk + exit seen).
   * Until then it waits; `truncate()` is the explicit escape hatch.
   */
  endRound(): void {
    const round = this.requireCurrent();
    if (round.phase !== "open") {
      throw new Error(`endRound: ${round.id} is ${round.phase}, expected open`);
    }
    round.phase = "closing";
    this.evidence.record({
      roundId: round.id,
      generation: round.generation,
      messageId: null,
      event: "lifecycle",
      disposition: "state-transition",
      detail: "open -> closing; waiting for stream drain or explicit truncation",
    });
    this.maybeComplete(round);
  }

  /** Explicitly terminate the current round without full drain. */
  truncate(reason: string): boolean {
    const round = this.requireCurrent();
    return this.finalize(round, "truncated", reason);
  }

  /** Deliver one transport message into the runtime. */
  receive(message: RoundMessage): void {
    const round = this.rounds.get(message.roundId);
    if (!round) {
      this.evidence.record({
        roundId: message.roundId,
        generation: message.generation,
        messageId: message.messageId,
        event: message.kind,
        disposition: "dropped-unknown-round",
        detail: "no such round; message dropped",
      });
      return;
    }
    if (round.isTerminal) {
      // Late message: attributed ONLY to its original round, as evidence.
      round.lateMessageIds.push(message.messageId);
      this.evidence.record({
        roundId: round.id,
        generation: round.generation,
        messageId: message.messageId,
        event: message.kind,
        disposition: "late-attributed",
        detail:
          `arrived after ${round.id} terminated (${round.terminalState}); ` +
          `filed on original round as evidence only, state unchanged`,
      });
      return;
    }
    switch (message.kind) {
      case "stdout":
        round.stdout.push({
          seq: message.seq,
          chunk: message.chunk,
          final: message.final,
          messageId: message.messageId,
        });
        if (message.final) round.stdoutDrained = true;
        break;
      case "assertion":
        round.assertions.push({
          seq: message.seq,
          name: message.name,
          passed: message.passed,
          detail: message.detail,
          messageId: message.messageId,
        });
        break;
      case "exit":
        round.exit = { code: message.code, signal: message.signal, messageId: message.messageId };
        break;
    }
    this.evidence.record({
      roundId: round.id,
      generation: round.generation,
      messageId: message.messageId,
      event: message.kind,
      disposition: "accepted",
      detail: `applied to ${round.id} (phase=${round.phase}, seq=${message.seq})`,
    });
    this.maybeComplete(round);
  }

  roundById(id: string): Round | undefined {
    return this.rounds.get(id);
  }

  allRounds(): readonly Round[] {
    return this.order;
  }

  private requireCurrent(): Round {
    if (!this.current) throw new Error("no active round");
    return this.current;
  }

  private maybeComplete(round: Round): void {
    if (round.phase === "closing" && round.drained) {
      this.finalize(round, "completed", "streams drained (final stdout chunk + exit received)");
    }
  }

  /** Terminal transition with uniqueness guard: one terminal state per round, ever. */
  private finalize(round: Round, state: TerminalState, reason: string): boolean {
    if (round.terminalState !== null) {
      this.evidence.record({
        roundId: round.id,
        generation: round.generation,
        messageId: null,
        event: "lifecycle",
        disposition: "rejected-duplicate-terminal",
        detail:
          `attempted '${state}' but ${round.id} is already terminal ` +
          `(${round.terminalState}); unique terminal state preserved`,
      });
      return false;
    }
    round.phase = state;
    round.terminalState = state;
    round.terminalReason = reason;
    this.evidence.record({
      roundId: round.id,
      generation: round.generation,
      messageId: null,
      event: "lifecycle",
      disposition: "state-transition",
      detail: `terminal: ${state} — ${reason}`,
    });
    return true;
  }
}
