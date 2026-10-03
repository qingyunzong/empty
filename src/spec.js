import { PlannerError, CODES } from './errors.js';
import { parseExpression, collectRefs } from './expr.js';

export const ARTIFACT_TYPES = new Set(['file', 'dataset', 'metric']);

function isPlainObject(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

function checkName(value, where) {
  if (typeof value !== 'string' || value.length === 0) {
    throw new PlannerError(CODES.FIELD_TYPE, `${where} must be a non-empty string, got ${JSON.stringify(value)}`);
  }
}

function checkCost(value, where) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
    throw new PlannerError(CODES.FIELD_TYPE, `${where} must be a finite number >= 0, got ${JSON.stringify(value)}`);
  }
}

// Validates a raw spec and returns a normalized, deeply-frozen internal form.
// Throws PlannerError on any problem; never returns a partial result.
export function validateSpec(raw) {
  if (!isPlainObject(raw)) {
    throw new PlannerError(CODES.SPEC_SHAPE, 'spec must be a JSON object');
  }
  checkCost(raw.budget, 'budget');
  if (!Array.isArray(raw.targets) || raw.targets.length === 0) {
    throw new PlannerError(CODES.FIELD_TYPE, 'targets must be a non-empty array of artifact names');
  }
  raw.targets.forEach((t, i) => checkName(t, `targets[${i}]`));
  if (!Array.isArray(raw.tasks) || raw.tasks.length === 0) {
    throw new PlannerError(CODES.FIELD_TYPE, 'tasks must be a non-empty array');
  }

  const taskNames = new Set();
  const artifactTypes = new Map(); // artifact name -> declared type
  const tasks = raw.tasks.map((t, i) => {
    const where = `tasks[${i}]`;
    if (!isPlainObject(t)) {
      throw new PlannerError(CODES.SPEC_SHAPE, `${where} must be an object`);
    }
    checkName(t.name, `${where}.name`);
    if (taskNames.has(t.name)) {
      throw new PlannerError(CODES.DUPLICATE, `duplicate task name ${JSON.stringify(t.name)}`);
    }
    taskNames.add(t.name);
    checkCost(t.cost, `${where}.cost`);
    if (!Array.isArray(t.produces) || t.produces.length === 0) {
      throw new PlannerError(CODES.FIELD_TYPE, `${where}.produces must be a non-empty array`);
    }
    const produces = t.produces.map((p, j) => {
      const pwhere = `${where}.produces[${j}]`;
      if (!isPlainObject(p)) {
        throw new PlannerError(CODES.SPEC_SHAPE, `${pwhere} must be an object`);
      }
      checkName(p.name, `${pwhere}.name`);
      if (!ARTIFACT_TYPES.has(p.type)) {
        throw new PlannerError(
          CODES.BAD_ARTIFACT_TYPE,
          `${pwhere}.type must be one of file|dataset|metric, got ${JSON.stringify(p.type)}`,
        );
      }
      const existing = artifactTypes.get(p.name);
      if (existing !== undefined && existing !== p.type) {
        throw new PlannerError(
          CODES.DUPLICATE,
          `artifact ${JSON.stringify(p.name)} is produced with conflicting types ${JSON.stringify(existing)} and ${JSON.stringify(p.type)}`,
        );
      }
      artifactTypes.set(p.name, p.type);
      return { name: p.name, type: p.type };
    });
    let requires = null;
    if (t.requires !== undefined && t.requires !== null && t.requires !== '') {
      requires = parseExpression(t.requires); // E_PARSE / E_FIELD_TYPE on failure
    }
    return { name: t.name, cost: t.cost, produces, requires };
  });

  // Static reference checks: every referenced artifact must exist, and an
  // explicit type qualifier must match the producer's declared type.
  for (const task of tasks) {
    if (!task.requires) continue;
    for (const ref of collectRefs(task.requires)) {
      const declared = artifactTypes.get(ref.name);
      if (declared === undefined) {
        throw new PlannerError(
          CODES.UNKNOWN_REF,
          `task ${JSON.stringify(task.name)} references unknown artifact ${JSON.stringify(ref.name)}`,
        );
      }
      if (ref.type !== null) {
        if (!ARTIFACT_TYPES.has(ref.type)) {
          throw new PlannerError(
            CODES.BAD_ARTIFACT_TYPE,
            `task ${JSON.stringify(task.name)} uses unknown type qualifier ${JSON.stringify(ref.type)}`,
          );
        }
        if (ref.type !== declared) {
          throw new PlannerError(
            CODES.TYPE_MISMATCH,
            `task ${JSON.stringify(task.name)} references ${ref.type}:${ref.name} but ${JSON.stringify(ref.name)} is produced as type ${JSON.stringify(declared)}`,
          );
        }
      }
    }
  }

  for (const target of raw.targets) {
    if (!artifactTypes.has(target)) {
      throw new PlannerError(CODES.UNKNOWN_REF, `target artifact ${JSON.stringify(target)} is not produced by any task`);
    }
  }

  return Object.freeze({
    budget: raw.budget,
    targets: Object.freeze([...raw.targets]),
    tasks: Object.freeze(tasks.map((t) => Object.freeze({
      name: t.name,
      cost: t.cost,
      produces: Object.freeze(t.produces.map((p) => Object.freeze({ ...p }))),
      requires: t.requires,
    }))),
  });
}
