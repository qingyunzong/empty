export interface RenameEntry {
  from: string;
  to: string;
}

export interface MappingFile {
  caseFold?: boolean;
  renames: RenameEntry[];
}

export interface PlanStep {
  from: string;
  to: string;
  /** true when this step moves a file to a temporary name to break a cycle */
  temp: boolean;
}

export interface Plan {
  caseFold: boolean;
  /** logical renames with no-ops removed */
  renames: RenameEntry[];
  /** executable steps, including temporary moves for cycle breaking */
  steps: PlanStep[];
}

export type JournalEntry =
  | { type: "plan"; id: string; caseFold: boolean; renames: RenameEntry[]; steps: PlanStep[]; createdAt: string }
  | { type: "step"; index: number; recovered?: boolean }
  | { type: "done" }
  | { type: "undo-plan"; steps: PlanStep[]; createdAt: string }
  | { type: "undo-step"; index: number; recovered?: boolean }
  | { type: "undo-done" };

export const JOURNAL_FILE = ".photo-rename.journal.jsonl";
