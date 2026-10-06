export interface Rename {
  from: string;
  to: string;
}

export interface Mapping {
  caseFold: boolean;
  renames: Rename[];
}

export type StepKind = "rename" | "temp";
export type StepStatus = "pending" | "doing" | "done";

export interface PlanStep {
  index: number;
  kind: StepKind;
  from: string;
  to: string;
  status: StepStatus;
}

export interface Journal {
  version: 1;
  id: string;
  kind: "apply" | "rollback";
  dir: string;
  caseFold: boolean;
  createdAt: string;
  rollbackOf?: string;
  initial: string[];
  final: string[];
  steps: PlanStep[];
}

export function makeFold(caseFold: boolean): (name: string) => string {
  return caseFold ? (name) => name.toLowerCase() : (name) => name;
}
