/**
 * Event endpoint and scenario runner.
 *
 * Messages may arrive out of order; the endpoint buffers them and replays
 * them to the lock manager ordered by integer logical clock (ties broken by
 * arrival sequence for determinism). After every applied step the
 * mutual-exclusion invariant is checked.
 */

import { LockManager, LockMessage, StepRecord } from "./lock-manager";

export class LockSimulator {
  readonly manager = new LockManager();
  private buffer: { message: LockMessage; arrival: number }[] = [];
  private arrivalCounter = 0;

  /** Enqueue a message; nothing is applied until flush(). */
  deliver(message: LockMessage): void {
    if (!Number.isInteger(message.clock)) {
      throw new Error(`logical clock must be an integer, got ${message.clock}`);
    }
    this.buffer.push({ message, arrival: this.arrivalCounter++ });
  }

  /** Apply all buffered messages in logical-clock order. */
  flush(): StepRecord[] {
    const ordered = this.buffer
      .slice()
      .sort((a, b) => a.message.clock - b.message.clock || a.arrival - b.arrival);
    this.buffer = [];
    const records: StepRecord[] = [];
    for (const { message } of ordered) {
      const record = this.manager.apply(message);
      if (!record.mutexOk) {
        throw new Error(
          `mutual exclusion violated at step ${record.step} ` +
            `(${message.kind} from ${message.pageId} @clock ${message.clock})`,
        );
      }
      records.push(record);
    }
    return records;
  }
}

/** Deterministic shuffle (Fisher-Yates with a seeded LCG) for tests. */
export function shuffled<T>(items: T[], seed: number): T[] {
  const out = items.slice();
  let state = seed >>> 0 || 1;
  const rand = (): number => {
    state = (state * 1664525 + 1013904223) >>> 0;
    return state / 0x100000000;
  };
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    const tmp = out[i] as T;
    out[i] = out[j] as T;
    out[j] = tmp;
  }
  return out;
}

/** Human-readable per-step ownership report. */
export function renderLog(records: StepRecord[]): string {
  const lines: string[] = [];
  for (const r of records) {
    const m = r.message;
    const who = `${m.pageId}${"generation" in m ? `#${m.generation}` : ""}`;
    const target = "resource" in m ? ` ${m.resource}` : "";
    const own = Object.entries(r.ownership)
      .map(([res, holder]) => `${res}=${holder}`)
      .join(" ");
    const queues = Object.entries(r.queues)
      .map(([res, q]) => `${res}:[${q.join(",")}]`)
      .join(" ");
    lines.push(
      `step ${String(r.step).padStart(2)} | clock ${String(m.clock).padStart(2)} | ` +
        `${m.kind.padEnd(7)} ${who}${target} -> ${r.outcome}` +
        `${r.note !== undefined ? ` (${r.note})` : ""}` +
        ` | owners: ${own || "-"}` +
        `${queues ? ` | waiting: ${queues}` : ""}` +
        ` | mutex:${r.mutexOk ? "OK" : "VIOLATED"}`,
    );
  }
  return lines.join("\n");
}
