import { digestEquals, isSha256Hex, sha256Hex, stableStringify } from "./digest.js";

export const ACTION_KINDS = ["fetch", "transform", "aggregate", "emit"] as const;
export type ActionKind = (typeof ACTION_KINDS)[number];

export interface Action {
  kind: ActionKind;
  inputs: string[];
  note?: string;
}

export interface ResourceInput {
  id: string;
  content: string;
  digest: string;
}

export interface PlanRequest {
  resources: ResourceInput[];
  actions: Action[];
}

export interface PlanStep {
  seq: number;
  kind: ActionKind;
  inputs: string[];
  note?: string;
}

export interface Evidence {
  resourceId: string;
  declaredDigest: string;
  computedDigest: string;
  verified: boolean;
}

export interface Plan {
  steps: PlanStep[];
  evidence: Evidence[];
  planDigest: string;
}

export class PlanRejection extends Error {
  readonly problems: readonly string[];
  constructor(problems: readonly string[]) {
    super(`plan rejected (${problems.length} problem(s)): ${problems.join("; ")}`);
    this.name = "PlanRejection";
    this.problems = problems;
  }
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function validateResources(
  raw: unknown,
  problems: string[],
): { resources: ResourceInput[]; evidence: Evidence[] } {
  const resources: ResourceInput[] = [];
  const evidence: Evidence[] = [];
  if (!Array.isArray(raw)) {
    problems.push("resources must be an array");
    return { resources, evidence };
  }
  const seen = new Set<string>();
  raw.forEach((entry, i) => {
    const where = `resources[${i}]`;
    if (!isPlainObject(entry)) {
      problems.push(`${where} must be an object with id/content/digest`);
      return;
    }
    const { id, content, digest } = entry;
    if (typeof id !== "string" || id.length === 0) {
      problems.push(`${where}.id must be a non-empty string`);
      return;
    }
    if (seen.has(id)) {
      problems.push(`${where}.id "${id}" is duplicated`);
      return;
    }
    seen.add(id);
    if (typeof content !== "string") {
      problems.push(`${where} ("${id}").content must be a string`);
      return;
    }
    if (typeof digest !== "string" || !isSha256Hex(digest.toLowerCase())) {
      problems.push(`${where} ("${id}").digest must be a sha256 hex string`);
      return;
    }
    const computed = sha256Hex(content);
    if (!digestEquals(digest, computed)) {
      problems.push(
        `${where} ("${id}") digest mismatch: declared ${digest.toLowerCase()} != computed ${computed}`,
      );
      return;
    }
    resources.push({ id, content, digest: digest.toLowerCase() });
    evidence.push({
      resourceId: id,
      declaredDigest: digest.toLowerCase(),
      computedDigest: computed,
      verified: true,
    });
  });
  return { resources, evidence };
}

function validateActions(
  raw: unknown,
  knownIds: ReadonlySet<string>,
  problems: string[],
): Action[] {
  const actions: Action[] = [];
  if (!Array.isArray(raw)) {
    problems.push("actions must be an array of structured action objects");
    return actions;
  }
  raw.forEach((entry, i) => {
    const where = `actions[${i}]`;
    if (!isPlainObject(entry)) {
      problems.push(
        `${where} is not a structured action object (got ${
          Array.isArray(entry) ? "array" : typeof entry
        }); descriptive text is never parsed into actions`,
      );
      return;
    }
    const { kind, inputs, note } = entry;
    if (typeof kind !== "string" || !(ACTION_KINDS as readonly string[]).includes(kind)) {
      problems.push(
        `${where}.kind must be one of ${ACTION_KINDS.join("/")}, got ${JSON.stringify(kind)}`,
      );
      return;
    }
    if (
      !Array.isArray(inputs) ||
      inputs.length === 0 ||
      !inputs.every((x) => typeof x === "string" && x.length > 0)
    ) {
      problems.push(`${where}.inputs must be a non-empty array of resource id strings`);
      return;
    }
    const unknown = (inputs as string[]).filter((id) => !knownIds.has(id));
    if (unknown.length > 0) {
      problems.push(
        `${where}.inputs references undeclared resource id(s): ${unknown.join(", ")}`,
      );
      return;
    }
    if (note !== undefined && typeof note !== "string") {
      problems.push(`${where}.note must be a string when present`);
      return;
    }
    const action: Action = { kind: kind as ActionKind, inputs: [...(inputs as string[])] };
    if (typeof note === "string") {
      action.note = note;
    }
    actions.push(action);
  });
  return actions;
}

/**
 * Validate a batch and, only if every check passes, produce an ordered plan
 * plus verification evidence. The batch is all-or-nothing: any problem (bad
 * digest, unstructured entry, unknown reference) rejects the whole request.
 *
 * The function is side-effect free on failure: `emit` is invoked exactly once
 * and only after the full batch has been accepted.
 */
export function createPlan(request: unknown, emit?: (plan: Plan) => void): Plan {
  const problems: string[] = [];
  if (!isPlainObject(request)) {
    throw new PlanRejection(["request must be an object with resources and actions"]);
  }

  const { resources, evidence } = validateResources(request.resources, problems);
  const knownIds = new Set(resources.map((r) => r.id));
  const actions = validateActions(request.actions, knownIds, problems);

  if (problems.length > 0) {
    throw new PlanRejection(problems);
  }

  const steps: PlanStep[] = actions.map((action, seq) => {
    const step: PlanStep = { seq, kind: action.kind, inputs: [...action.inputs] };
    if (action.note !== undefined) {
      step.note = action.note;
    }
    return step;
  });

  const plan: Plan = {
    steps,
    evidence,
    planDigest: sha256Hex(stableStringify({ steps, evidence })),
  };

  if (emit !== undefined) {
    emit(plan);
  }
  return plan;
}
