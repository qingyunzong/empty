export type MessageType = "stdout" | "assert" | "exit";

export interface Message {
  readonly slot: string;
  readonly generation: number;
  readonly type: MessageType;
  readonly payload: string;
  readonly emitSeq: number;
}

export type Disposition = "applied" | "late" | "rejected";

export interface Evidence {
  readonly arrivalSeq: number;
  readonly message: Message;
  readonly disposition: Disposition;
  readonly reason: string;
}

export type RoundPhase = "open" | "draining" | "closed";

export interface FinalState {
  readonly status: "closed-drained" | "closed-truncated";
  readonly exitCode: number | null;
  readonly stdout: string;
  readonly assertions: readonly string[];
  readonly truncatedBytes: number;
  readonly truncateReason: string | null;
}

export interface RoundView {
  readonly slot: string;
  readonly generation: number;
  readonly phase: RoundPhase;
  readonly finalState: FinalState | null;
  readonly evidence: readonly Evidence[];
}

function roundKey(slot: string, generation: number): string {
  return `${slot}#${generation}`;
}

class Round {
  phase: RoundPhase = "open";
  finalState: FinalState | null = null;
  readonly evidence: Evidence[] = [];

  private buffer: string[] = [];
  private flushScheduled = false;
  private readonly stdoutParts: string[] = [];
  private readonly assertionLog: string[] = [];
  private exitCode: number | null = null;
  private closeWaiters: Array<() => void> = [];

  constructor(
    readonly slot: string,
    readonly generation: number,
  ) {}

  get pendingBytes(): number {
    return this.buffer.reduce((total, chunk) => total + chunk.length, 0);
  }

  apply(message: Message): void {
    switch (message.type) {
      case "stdout":
        this.buffer.push(message.payload);
        this.scheduleFlush();
        break;
      case "assert":
        this.assertionLog.push(message.payload);
        break;
      case "exit":
        if (this.exitCode === null) {
          this.exitCode = Number(message.payload);
          this.beginDrain();
        }
        break;
    }
  }

  beginDrain(): void {
    if (this.phase !== "open") return;
    this.phase = "draining";
    if (this.buffer.length === 0 && !this.flushScheduled) {
      this.close("closed-drained", null, 0);
    }
  }

  truncate(reason: string): boolean {
    if (this.phase === "closed") return false;
    const lost = this.pendingBytes;
    this.buffer = [];
    this.close("closed-truncated", reason, lost);
    return true;
  }

  waitClosed(): Promise<FinalState> {
    if (this.finalState) return Promise.resolve(this.finalState);
    return new Promise((resolve) => {
      this.closeWaiters.push(() => resolve(this.finalState as FinalState));
    });
  }

  private scheduleFlush(): void {
    if (this.flushScheduled) return;
    this.flushScheduled = true;
    setImmediate(() => {
      this.flushScheduled = false;
      while (this.buffer.length > 0) {
        this.stdoutParts.push(this.buffer.shift() as string);
      }
      if (this.phase === "draining" && this.buffer.length === 0) {
        this.close("closed-drained", null, 0);
      }
    });
  }

  private close(
    status: "closed-drained" | "closed-truncated",
    truncateReason: string | null,
    truncatedBytes: number,
  ): void {
    this.phase = "closed";
    this.finalState = Object.freeze({
      status,
      exitCode: this.exitCode,
      stdout: this.stdoutParts.join(""),
      assertions: Object.freeze([...this.assertionLog]),
      truncatedBytes,
      truncateReason,
    });
    const waiters = this.closeWaiters;
    this.closeWaiters = [];
    for (const notify of waiters) notify();
  }
}

export class Runtime {
  private readonly rounds = new Map<string, Round>();
  private readonly currentGeneration = new Map<string, number>();
  private readonly emitCounters = new Map<string, number>();
  private arrivalCounter = 0;
  readonly log: Evidence[] = [];

  startRound(slot: string): RoundHandle {
    const generation = (this.currentGeneration.get(slot) ?? 0) + 1;
    this.currentGeneration.set(slot, generation);
    this.rounds.set(roundKey(slot, generation), new Round(slot, generation));
    return new RoundHandle(this, slot, generation);
  }

  nextEmitSeq(slot: string, generation: number): number {
    const key = roundKey(slot, generation);
    const next = (this.emitCounters.get(key) ?? 0) + 1;
    this.emitCounters.set(key, next);
    return next;
  }

  dispatch(message: Message): Evidence {
    const round = this.rounds.get(roundKey(message.slot, message.generation));
    let disposition: Disposition;
    let reason: string;
    if (!round) {
      disposition = "rejected";
      reason = `round ${message.slot}#gen${message.generation} does not exist`;
    } else if (round.phase === "closed") {
      disposition = "late";
      reason =
        `round ${message.slot}#gen${message.generation} already closed ` +
        `(${round.finalState?.status}); attributed to original round only, never to a newer generation`;
    } else {
      disposition = "applied";
      reason = `round ${message.slot}#gen${message.generation} ${round.phase}`;
      round.apply(message);
    }
    const evidence: Evidence = {
      arrivalSeq: ++this.arrivalCounter,
      message,
      disposition,
      reason,
    };
    this.log.push(evidence);
    if (round) round.evidence.push(evidence);
    return evidence;
  }

  endRound(slot: string, generation: number): Promise<FinalState> {
    const round = this.requireRound(slot, generation);
    round.beginDrain();
    return round.waitClosed();
  }

  truncateRound(slot: string, generation: number, reason: string): boolean {
    const round = this.requireRound(slot, generation);
    return round.truncate(reason);
  }

  getRound(slot: string, generation: number): RoundView | undefined {
    const round = this.rounds.get(roundKey(slot, generation));
    if (!round) return undefined;
    return {
      slot: round.slot,
      generation: round.generation,
      phase: round.phase,
      finalState: round.finalState,
      evidence: [...round.evidence],
    };
  }

  listRounds(): RoundView[] {
    const views: RoundView[] = [];
    for (const round of this.rounds.values()) {
      views.push({
        slot: round.slot,
        generation: round.generation,
        phase: round.phase,
        finalState: round.finalState,
        evidence: [...round.evidence],
      });
    }
    return views;
  }

  private requireRound(slot: string, generation: number): Round {
    const round = this.rounds.get(roundKey(slot, generation));
    if (!round) {
      throw new Error(`round ${slot}#gen${generation} does not exist`);
    }
    return round;
  }
}

export class RoundHandle {
  constructor(
    private readonly runtime: Runtime,
    readonly slot: string,
    readonly generation: number,
  ) {}

  write(chunk: string): Evidence {
    return this.runtime.dispatch(this.message("stdout", chunk));
  }

  assert(note: string): Evidence {
    return this.runtime.dispatch(this.message("assert", note));
  }

  exit(code: number): Evidence {
    return this.runtime.dispatch(this.message("exit", String(code)));
  }

  end(): Promise<FinalState> {
    return this.runtime.endRound(this.slot, this.generation);
  }

  truncate(reason: string): boolean {
    return this.runtime.truncateRound(this.slot, this.generation, reason);
  }

  message(type: MessageType, payload: string): Message {
    return {
      slot: this.slot,
      generation: this.generation,
      type,
      payload,
      emitSeq: this.runtime.nextEmitSeq(this.slot, this.generation),
    };
  }
}
