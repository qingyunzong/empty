/** Shared model for the evidence verifier. */

export const SOURCES = ["manifest", "trajectory", "filesummary"] as const;
export type SourceName = (typeof SOURCES)[number];

export const FIELDS = ["runId", "problemSummary", "stageSource"] as const;
export type FieldName = (typeof FIELDS)[number];

export const SOURCE_FILES: Record<SourceName, string> = {
  manifest: "manifest.jsonl",
  trajectory: "trajectory.jsonl",
  filesummary: "filesummary.jsonl",
};

/** 1-based line/column span inside a source file. Columns are end-exclusive. */
export interface Citation {
  source: SourceName;
  file: string;
  line: number;
  colStart: number;
  colEnd: number;
}

export interface FieldEvidence {
  value: string;
  citation: Citation;
}

export type IssueKind =
  | "value-mismatch" // 矛盾: two present values disagree
  | "missing-item" // 缺失证据: item absent from a source
  | "missing-field" // 缺失证据: field absent from a present record
  | "parse-error" // 缺失证据: line could not be parsed
  | "duplicate-record"; // 矛盾: same itemId twice in one source

export type ItemStatus = "consistent" | "unknown" | "conflict";

/** One disagreeing pair of citations: the minimal witness of a conflict. */
export interface ConflictPair {
  field: FieldName;
  a: FieldEvidence;
  b: FieldEvidence;
}

export interface Issue {
  kind: IssueKind;
  itemId: string | null;
  field: FieldName | null;
  message: string;
  citations: Citation[];
}

export interface ItemReport {
  itemId: string;
  status: ItemStatus;
  /** Sources where the item record was found. */
  presentIn: SourceName[];
  /** Sources where the item record is missing (缺失证据). */
  missingFrom: SourceName[];
  /** Minimal conflicting citation pairs, grouped per field. */
  conflictPairs: ConflictPair[];
  issues: Issue[];
}

export interface Report {
  items: ItemReport[];
  issues: Issue[]; // dataset-level issues (parse errors, duplicates)
  summary: {
    total: number;
    consistent: number;
    unknown: number;
    conflict: number;
  };
}
