/** An input resource: content addressed by its sha256 digest. */
export interface Resource {
  id: string;
  content: string;
  digest: string;
}

/** A single structured action. Never derived from free text. */
export interface Action {
  id: string;
  kind: string;
  /** IDs of input resources this action consumes. */
  inputs: string[];
  params?: Record<string, unknown>;
}

/** The only accepted input shape: a structured action list plus resources. */
export interface PlanRequest {
  resources: Resource[];
  actions: Action[];
}

/** One ordered step of a plan. */
export interface PlanStep {
  seq: number;
  action: Action;
  /** Hash of the canonical step, chained with the previous step hash. */
  stepHash: string;
  chainHash: string;
}

export interface Plan {
  planId: string;
  steps: PlanStep[];
  /** Resource IDs in first-reference order. */
  resourceIds: string[];
}

/** Tamper-evident proof binding a plan to its exact inputs. */
export interface Evidence {
  planId: string;
  /** resource id -> content digest, sorted by id. */
  resourceDigests: Record<string, string>;
  stepHashes: string[];
  finalChainHash: string;
  /** Root hash over the whole evidence; any field tamper breaks it. */
  rootHash: string;
}

export type VerifyResult =
  | { ok: true }
  | { ok: false; reason: string };
