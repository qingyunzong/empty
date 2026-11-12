export type Atom = bigint | string;
export type Row = Readonly<Record<string, Atom>>;

export interface InputRelation {
  name: string;
  attributes: readonly string[];
  rows: readonly Row[];
}

export interface JoinInput {
  relations: readonly InputRelation[];
  edges: ReadonlyArray<readonly [string, string]>;
}

export interface DirectedEdge {
  from: string;
  to: string;
}

export interface RowReport {
  row: Row;
  alive: boolean;
  firstDeletedBy?: DirectedEdge;
  missingKey?: Readonly<Partial<Record<string, Atom>>>;
}

export interface ReductionReport {
  relation: string;
  attributes: readonly string[];
  rowReports: readonly RowReport[];
  survivingRows: readonly Row[];
}

export interface ReductionStep {
  from: string;
  to: string;
  pass: 'postorder' | 'preorder';
  sharedAttributes: readonly string[];
  deletedCount: number;
}

export interface JoinPlan {
  relations: readonly string[];
  attributes: Readonly<Record<string, readonly string[]>>;
  root: string;
  parent: Readonly<Record<string, string | null>>;
  children: Readonly<Record<string, readonly string[]>>;
  adjacency: Readonly<Record<string, readonly string[]>>;
  postorder: readonly string[];
  preorder: readonly string[];
  edges: ReadonlyArray<readonly [string, string]>;
  digest: string;
}

export interface ReductionResult {
  plan: JoinPlan;
  digest: string;
  reduced: Readonly<Record<string, readonly Row[]>>;
  reports: Readonly<Record<string, ReductionReport>>;
  steps: readonly ReductionStep[];
  isEmpty: boolean;
}

export interface JoinResultBatch {
  vectors: ReadonlyArray<readonly number[]>;
  rows: readonly Row[];
  done: boolean;
  token?: string;
}
