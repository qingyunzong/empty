import * as fs from "node:fs";
import * as path from "node:path";
import { JOURNAL_FILE, JournalEntry } from "./types.js";

export interface JournalState {
  entries: JournalEntry[];
  plan: Extract<JournalEntry, { type: "plan" }> | undefined;
  done: boolean;
  completedSteps: Set<number>;
  undoPlan: Extract<JournalEntry, { type: "undo-plan" }> | undefined;
  undoDone: boolean;
  completedUndoSteps: Set<number>;
}

export function journalPath(dir: string): string {
  return path.join(dir, JOURNAL_FILE);
}

/** Append one entry and fsync so every executed step is durable. */
export function appendEntry(dir: string, entry: JournalEntry): void {
  const fd = fs.openSync(journalPath(dir), "a");
  try {
    fs.writeSync(fd, JSON.stringify(entry) + "\n");
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
}

/**
 * Read the journal. A truncated final line (crash mid-write) is ignored so
 * recovery can simply re-check and redo that step.
 */
export function readJournal(dir: string): JournalState {
  const entries: JournalEntry[] = [];
  const file = journalPath(dir);
  if (fs.existsSync(file)) {
    const text = fs.readFileSync(file, "utf8");
    const lines = text.split("\n");
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i]!.trim();
      if (line.length === 0) continue;
      try {
        entries.push(JSON.parse(line) as JournalEntry);
      } catch {
        if (i < lines.length - 1) throw new Error(`corrupt journal line ${i + 1} in ${file}`);
        // truncated tail from a crash: ignore, the step will be reconciled
      }
    }
  }
  const state: JournalState = {
    entries,
    plan: undefined,
    done: false,
    completedSteps: new Set<number>(),
    undoPlan: undefined,
    undoDone: false,
    completedUndoSteps: new Set<number>(),
  };
  for (const e of entries) {
    switch (e.type) {
      case "plan":
        state.plan = e;
        break;
      case "step":
        state.completedSteps.add(e.index);
        break;
      case "done":
        state.done = true;
        break;
      case "undo-plan":
        state.undoPlan = e;
        break;
      case "undo-step":
        state.completedUndoSteps.add(e.index);
        break;
      case "undo-done":
        state.undoDone = true;
        break;
    }
  }
  return state;
}
