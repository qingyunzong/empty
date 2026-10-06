import { createHash } from "node:crypto";
import { canonicalize } from "./canonical.js";
import { digestContent, digestValue, isDigestFormat, sha256Hex } from "./digest.js";
import type {
  Action,
  Evidence,
  Plan,
  PlanRequest,
  PlanStep,
  Resource,
} from "./types.js";

/** Raised for every rejection; carries a machine-readable reason code. */
export class PlanRejection extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = "PlanRejection";
    this.code = code;
  }
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function requireString(value: unknown, field: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new PlanRejection("INVALID_SHAPE", `field "${field}" must be a non-empty string`);
  }
  return value;
}

function parseResource(raw: unknown, index: number): Resource {
  if (!isPlainObject(raw)) {
    throw new PlanRejection(
      "INVALID_SHAPE",
      `resources[${index}] must be an object {id, content, digest}`,
    );
  }
  const id = requireString(raw.id, `resources[${index}].id`);
  if (typeof raw.content !== "string") {
    throw new PlanRejection("INVALID_SHAPE", `resources[${index}].content must be a string`);
  }
  if (!isDigestFormat(raw.digest)) {
    throw new PlanRejection(
      "INVALID_DIGEST_FORMAT",
      `resource "${id}" digest must be "sha256:<64 hex chars>"`,
    );
  }
  return { id, content: raw.content, digest: raw.digest };
}

function parseAction(raw: unknown, index: number): Action {
  // Descriptive text is never interpreted as an action: anything that is
  // not a structured object is rejected outright.
  if (!isPlainObject(raw)) {
    throw new PlanRejection(
      "UNSTRUCTURED_ACTION",
      `actions[${index}] is not a structured action object; descriptive text is not parsed`,
    );
  }
  const id = requireString(raw.id, `actions[${index}].id`);
  const kind = requireString(raw.kind, `actions[${index}].kind`);
  if (!Array.isArray(raw.inputs) || raw.inputs.some((v) => typeof v !== "string")) {
    throw new PlanRejection("INVALID_SHAPE", `actions[${index}].inputs must be a string array`);
  }
  const action: Action = { id, kind, inputs: raw.inputs as string[] };
  if (raw.params !== undefined) {
    if (!isPlainObject(raw.params)) {
      throw new PlanRejection("INVALID_SHAPE", `actions[${index}].params must be an object`);
    }
    action.params = raw.params;
  }
  return action;
}

const ALLOWED_REQUEST_KEYS = new Set(["resources", "actions"]);

/**
 * Build an ordered plan plus tamper-evident evidence from a structured
 * request. All-or-nothing: any digest mismatch, unknown resource
 * reference, or malformed entry rejects the entire batch and no plan
 * is produced.
 */
export function createPlan(request: unknown): { plan: Plan; evidence: Evidence } {
  // Only a structured action list is accepted. Prose, markdown, or any
  // non-object payload is rejected instead of being parsed into actions.
  if (!isPlainObject(request)) {
    throw new PlanRejection(
      "UNSTRUCTURED_INPUT",
      "request must be a structured object {resources, actions}; descriptive text is not parsed",
    );
  }
  for (const key of Object.keys(request)) {
    if (!ALLOWED_REQUEST_KEYS.has(key)) {
      throw new PlanRejection("INVALID_SHAPE", `unexpected request field "${key}"`);
    }
  }
  if (!Array.isArray(request.resources)) {
    throw new PlanRejection("INVALID_SHAPE", "request.resources must be an array");
  }
  if (!Array.isArray(request.actions)) {
    throw new PlanRejection("INVALID_SHAPE", "request.actions must be an array");
  }

  const resources = request.resources.map(parseResource);
  const actions = request.actions.map(parseAction);

  // Duplicate resource ids are ambiguous; reject the batch.
  const byId = new Map<string, Resource>();
  for (const resource of resources) {
    if (byId.has(resource.id)) {
      throw new PlanRejection("DUPLICATE_RESOURCE", `duplicate resource id "${resource.id}"`);
    }
    byId.set(resource.id, resource);
  }

  // Verify every digest before planning anything. A single mismatch
  // rejects the whole batch.
  const mismatches = resources.filter((r) => digestContent(r.content) !== r.digest);
  if (mismatches.length > 0) {
    throw new PlanRejection(
      "DIGEST_MISMATCH",
      `digest mismatch for resource(s): ${mismatches.map((r) => r.id).join(", ")}; entire batch rejected`,
    );
  }

  // Every action input must reference a known, digest-verified resource.
  for (const action of actions) {
    for (const input of action.inputs) {
      if (!byId.has(input)) {
        throw new PlanRejection(
          "UNKNOWN_RESOURCE",
          `action "${action.id}" references unknown resource "${input}"; entire batch rejected`,
        );
      }
    }
  }
  const actionIds = new Set<string>();
  for (const action of actions) {
    if (actionIds.has(action.id)) {
      throw new PlanRejection("DUPLICATE_ACTION", `duplicate action id "${action.id}"`);
    }
    actionIds.add(action.id);
  }

  // Ordered steps with a hash chain so reordering is detectable.
  const steps: PlanStep[] = [];
  let previousChain = "sha256:" + "0".repeat(64);
  actions.forEach((action, seq) => {
    const stepHash = digestValue({ seq, action });
    const chainHash = "sha256:" + sha256Hex(previousChain + "|" + stepHash);
    steps.push({ seq, action, stepHash, chainHash });
    previousChain = chainHash;
  });

  const resourceIds: string[] = [];
  for (const action of actions) {
    for (const input of action.inputs) {
      if (!resourceIds.includes(input)) resourceIds.push(input);
    }
  }

  const planId = "sha256:" + sha256Hex(
    createHash("sha256")
      .update(canonicalize({ resources: resources.map((r) => [r.id, r.digest]), actions }))
      .digest("hex"),
  );

  const resourceDigests: Record<string, string> = {};
  for (const resource of [...resources].sort((a, b) => a.id.localeCompare(b.id))) {
    resourceDigests[resource.id] = resource.digest;
  }

  const finalChainHash = steps.length > 0 ? steps[steps.length - 1]!.chainHash : previousChain;
  const evidence: Evidence = {
    planId,
    resourceDigests,
    stepHashes: steps.map((s) => s.stepHash),
    finalChainHash,
    rootHash: "",
  };
  evidence.rootHash = digestValue({
    planId: evidence.planId,
    resourceDigests: evidence.resourceDigests,
    stepHashes: evidence.stepHashes,
    finalChainHash: evidence.finalChainHash,
  });

  return { plan: { planId, steps, resourceIds }, evidence };
}
