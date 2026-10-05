export type FieldValue = string | number | boolean | null;

export interface DocFile {
  id: string;
  path: string;
  fields: Record<string, FieldValue>;
}

export interface Snapshot {
  files: Record<string, DocFile>;
}

export type ConflictKind = 'delete-vs-modify' | 'field' | 'path' | 'path-occupancy';

export type ResolutionChoice = 'local' | 'remote';

export interface Conflict {
  key: string;
  kind: ConflictKind;
  fileIds: string[];
  signature: string;
  message: string;
  base: unknown;
  local: unknown;
  remote: unknown;
}

export interface Resolution {
  key: string;
  choice: ResolutionChoice;
  signature: string;
}

export interface AppliedResolution {
  conflict: Conflict;
  choice: ResolutionChoice;
}

export type PlanOp =
  | { op: 'create'; file: DocFile }
  | { op: 'delete'; id: string }
  | { op: 'move'; id: string; from: string; to: string }
  | { op: 'update'; id: string; set: Record<string, FieldValue>; unset: string[] };

export interface ChangePlan {
  atomic: true;
  ops: PlanOp[];
}

export interface MergeResult {
  merged: Snapshot;
  conflicts: Conflict[];
  resolved: AppliedResolution[];
  revoked: Resolution[];
  plan: ChangePlan | null;
}
