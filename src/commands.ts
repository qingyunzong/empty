import { readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { parseMapping, preflight } from "./mapping.js";
import { buildPlan, inversePlan } from "./plan.js";
import { archiveJournal, isComplete, loadJournal, requireJournal, saveJournal } from "./journal.js";
import { execute, type ExecHooks, type ExecResult } from "./executor.js";
import type { Journal } from "./model.js";

export function createPlan(dir: string, mappingFile: string): Journal {
  const existing = loadJournal(dir);
  if (existing !== null) {
    if (!isComplete(existing)) {
      throw new Error(`an unfinished journal (${existing.id}) exists; run apply, verify or rollback first`);
    }
    archiveJournal(existing);
  }
  const mapping = parseMapping(readFileSync(mappingFile, "utf8"));
  const validated = preflight(dir, mapping);
  const id = randomUUID();
  const steps = buildPlan({
    renames: validated.renames,
    caseFold: validated.caseFold,
    journalId: id,
    existingNames: validated.dirNames,
  });
  const journal: Journal = {
    version: 1,
    id,
    kind: "apply",
    dir,
    caseFold: validated.caseFold,
    createdAt: new Date().toISOString(),
    initial: validated.renames.map((r) => r.from),
    final: validated.renames.map((r) => r.to),
    steps,
  };
  saveJournal(journal);
  return journal;
}

export function applyPlan(dir: string, hooks: ExecHooks = {}): ExecResult {
  return execute(dir, hooks);
}

export function rollback(dir: string, hooks: ExecHooks = {}): { journal: Journal; result: ExecResult } {
  const journal = requireJournal(dir);
  if (!isComplete(journal)) throw new Error("cannot rollback: the current plan is not fully applied");
  const undo: Journal = {
    version: 1,
    id: randomUUID(),
    kind: "rollback",
    dir,
    caseFold: journal.caseFold,
    createdAt: new Date().toISOString(),
    rollbackOf: journal.id,
    initial: journal.final,
    final: journal.initial,
    steps: inversePlan(journal.steps),
  };
  archiveJournal(journal);
  saveJournal(undo);
  const result = execute(dir, hooks);
  return { journal: undo, result };
}
