export type Disposition =
  | "accepted" // applied to the state of its owning round
  | "late-attributed" // arrived after the owning round went terminal; filed as evidence on the original round only
  | "rejected-stale-handle" // write attempted through a handle whose generation is no longer open
  | "dropped-unknown-round" // references a round that never existed
  | "rejected-duplicate-terminal" // attempt to terminate an already-terminal round
  | "state-transition"; // lifecycle transition of a round

export interface EvidenceEntry {
  /** Citation id: E1, E2, ... in global recording order. */
  readonly eid: string;
  /** Logical clock tick. */
  readonly tick: number;
  readonly roundId: string;
  readonly generation: number;
  /** Message this entry cites, or null for lifecycle events. */
  readonly messageId: string | null;
  readonly event: string;
  readonly disposition: Disposition;
  readonly detail: string;
}

/** Append-only, totally ordered log; every entry is citable by its eid. */
export class EvidenceLog {
  private readonly entries: EvidenceEntry[] = [];
  private tick = 0;

  record(input: Omit<EvidenceEntry, "eid" | "tick">): EvidenceEntry {
    const entry: EvidenceEntry = {
      eid: `E${this.entries.length + 1}`,
      tick: ++this.tick,
      ...input,
    };
    this.entries.push(entry);
    return entry;
  }

  all(): readonly EvidenceEntry[] {
    return this.entries;
  }

  forRound(roundId: string): EvidenceEntry[] {
    return this.entries.filter((e) => e.roundId === roundId);
  }

  count(disposition: Disposition): number {
    return this.entries.filter((e) => e.disposition === disposition).length;
  }

  format(): string {
    const lines = this.entries.map((e) => {
      const msg = e.messageId ?? "-";
      return `${e.eid.padEnd(4)} t${String(e.tick).padStart(3, "0")} ${e.roundId.padEnd(8)} gen=${e.generation} msg=${msg.padEnd(16)} ${e.disposition.padEnd(26)} ${e.event}: ${e.detail}`;
    });
    return lines.join("\n");
  }
}
