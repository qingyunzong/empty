import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Journal } from "./model.js";

export const JOURNAL_FILE = ".photo-organize.journal.json";

export function journalPath(dir: string): string {
  return join(dir, JOURNAL_FILE);
}

export function loadJournal(dir: string): Journal | null {
  const path = journalPath(dir);
  if (!existsSync(path)) return null;
  const journal = JSON.parse(readFileSync(path, "utf8")) as Journal;
  if (journal.version !== 1) throw new Error(`unsupported journal version: ${String(journal.version)}`);
  return journal;
}

export function requireJournal(dir: string): Journal {
  const journal = loadJournal(dir);
  if (journal === null) throw new Error(`no journal found in ${dir}; run "plan" first`);
  return journal;
}

export function saveJournal(journal: Journal): void {
  const path = journalPath(journal.dir);
  const tmp = `${path}.tmp-${journal.id}`;
  writeFileSync(tmp, JSON.stringify(journal, null, 2) + "\n");
  renameSync(tmp, path);
}

export function archiveJournal(journal: Journal): void {
  const path = journalPath(journal.dir);
  if (existsSync(path)) renameSync(path, join(journal.dir, `.photo-organize.journal.${journal.id}.done.json`));
}

export function isComplete(journal: Journal): boolean {
  return journal.steps.every((s) => s.status === "done");
}
