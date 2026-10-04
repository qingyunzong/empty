import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

/**
 * Records every oracle judgment as a JSONL line so the exact sequence
 * of decisions is persisted and the run is reproducible.
 */
export class TraceRecorder {
  private readonly entries: Record<string, unknown>[] = [];

  constructor(private readonly filePath: string | null) {
    if (filePath !== null) {
      mkdirSync(dirname(filePath), { recursive: true });
      writeFileSync(filePath, "");
    }
  }

  record(entry: Record<string, unknown>): void {
    this.entries.push(entry);
    if (this.filePath !== null) {
      appendFileSync(this.filePath, `${JSON.stringify(entry)}\n`);
    }
  }

  snapshot(): Record<string, unknown>[] {
    return this.entries.map((e) => ({ ...e }));
  }
}
