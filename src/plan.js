import { createHash } from "node:crypto";
import { openSync, fsyncSync, closeSync, readFileSync, writeFileSync, renameSync } from "node:fs";
import { dirname, join } from "node:path";

export class PlanError extends Error {
  constructor(message) {
    super(message);
    this.name = "PlanError";
  }
}

export function canonicalize(value) {
  if (Array.isArray(value)) {
    return `[${value.map(canonicalize).join(",")}]`;
  }
  if (value !== null && typeof value === "object") {
    const keys = Object.keys(value).sort();
    return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalize(value[k])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

export function planHash(result) {
  const payload = canonicalize({
    equal: result.equal,
    witness: result.witness,
    tasks: result.tasks,
    cost: result.cost,
  });
  return createHash("sha256").update(payload).digest("hex");
}

export function buildPlan(result) {
  return {
    version: 1,
    equal: result.equal,
    witness: result.witness,
    tasks: result.tasks,
    cost: result.cost,
    planHash: planHash(result),
  };
}

export function savePlan(path, plan) {
  const dir = dirname(path);
  const tmpPath = join(dir, `.plan.${process.pid}.${Date.now()}.tmp`);
  const data = `${JSON.stringify(plan, null, 2)}\n`;
  const fd = openSync(tmpPath, "w");
  try {
    writeFileSync(fd, data);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  renameSync(tmpPath, path);
}

function validatePlan(plan) {
  if (plan === null || typeof plan !== "object" || Array.isArray(plan)) {
    throw new PlanError("plan file does not contain a JSON object");
  }
  if (plan.version !== 1) {
    throw new PlanError(`unsupported plan version ${JSON.stringify(plan.version)}`);
  }
  if (typeof plan.equal !== "boolean") {
    throw new PlanError("plan field \"equal\" must be a boolean");
  }
  if (!(plan.witness === null || (Array.isArray(plan.witness) && plan.witness.every((s) => typeof s === "string")))) {
    throw new PlanError("plan field \"witness\" must be null or an array of strings");
  }
  if (
    !Array.isArray(plan.tasks) ||
    !plan.tasks.every(
      (t) =>
        t !== null &&
        typeof t === "object" &&
        typeof t.id === "string" &&
        Number.isInteger(t.cost) &&
        t.cost >= 0
    )
  ) {
    throw new PlanError("plan field \"tasks\" must be an array of {id, cost} objects");
  }
  if (!Number.isInteger(plan.cost) || plan.cost < 0) {
    throw new PlanError("plan field \"cost\" must be a non-negative integer");
  }
  if (typeof plan.planHash !== "string" || planHash(plan) !== plan.planHash) {
    throw new PlanError("plan hash mismatch: file is corrupt or truncated");
  }
  return plan;
}

export function loadPlan(path) {
  let text;
  try {
    text = readFileSync(path, "utf8");
  } catch (err) {
    throw new PlanError(`cannot read plan file: ${err.message}`);
  }
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new PlanError("plan file is not valid JSON (truncated or corrupt)");
  }
  return validatePlan(parsed);
}

export class PlanStore {
  constructor(path) {
    this.path = path;
    this.current = null;
  }

  save(result) {
    const plan = buildPlan(result);
    savePlan(this.path, plan);
    this.current = plan;
    return plan;
  }

  load() {
    const plan = loadPlan(this.path);
    this.current = plan;
    return plan;
  }
}
