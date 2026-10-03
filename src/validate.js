import { PlanError } from './errors.js';
import { parseExpression, collectRefs } from './parser.js';

export const ARTIFACT_TYPES = Object.freeze(['file', 'dataset', 'metric']);
const ARTIFACT_TYPE_SET = new Set(ARTIFACT_TYPES);

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function requireNonEmptyString(value, where) {
  if (typeof value !== 'string' || value.length === 0) {
    throw new PlanError('E_FIELD_TYPE', `${where} must be a non-empty string`);
  }
}

function requireCost(value, where) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
    throw new PlanError('E_FIELD_TYPE', `${where} must be a non-negative finite number`);
  }
}

export function validateSpec(spec) {
  if (!isPlainObject(spec)) {
    throw new PlanError('E_FIELD_TYPE', 'spec must be a JSON object');
  }
  if (spec.name !== undefined) requireNonEmptyString(spec.name, 'spec.name');
  requireCost(spec.budget, 'spec.budget');
  if (!Array.isArray(spec.tasks)) {
    throw new PlanError('E_FIELD_TYPE', 'spec.tasks must be an array');
  }

  const taskNames = new Set();
  const producers = new Map();
  const tasks = spec.tasks.map((task, index) => {
    const where = `tasks[${index}]`;
    if (!isPlainObject(task)) {
      throw new PlanError('E_FIELD_TYPE', `${where} must be an object`);
    }
    requireNonEmptyString(task.name, `${where}.name`);
    if (taskNames.has(task.name)) {
      throw new PlanError('E_DUPLICATE_TASK', `duplicate task name "${task.name}"`);
    }
    taskNames.add(task.name);
    requireCost(task.cost, `${where}.cost`);
    if (task.requires !== undefined && typeof task.requires !== 'string') {
      throw new PlanError('E_FIELD_TYPE', `${where}.requires must be a string`);
    }
    if (!Array.isArray(task.produces)) {
      throw new PlanError('E_FIELD_TYPE', `${where}.produces must be an array`);
    }
    const produces = task.produces.map((artifact, artifactIndex) => {
      const artifactWhere = `${where}.produces[${artifactIndex}]`;
      if (!isPlainObject(artifact)) {
        throw new PlanError('E_FIELD_TYPE', `${artifactWhere} must be an object`);
      }
      requireNonEmptyString(artifact.name, `${artifactWhere}.name`);
      if (!ARTIFACT_TYPE_SET.has(artifact.type)) {
        throw new PlanError(
          'E_ARTIFACT_TYPE',
          `${artifactWhere}.type must be one of ${ARTIFACT_TYPES.join(', ')}; got ${JSON.stringify(artifact.type)}`,
        );
      }
      if (producers.has(artifact.name)) {
        throw new PlanError('E_DUPLICATE_ARTIFACT', `artifact "${artifact.name}" is produced by more than one task`);
      }
      producers.set(artifact.name, artifact.type);
      return { name: artifact.name, type: artifact.type };
    });
    return { name: task.name, cost: task.cost, requires: task.requires, produces };
  });

  const expressions = new Map();
  for (const task of tasks) {
    if (task.requires === undefined) continue;
    const ast = parseExpression(task.requires);
    for (const ref of collectRefs(ast)) {
      if (!taskNames.has(ref)) {
        throw new PlanError('E_MISSING_REF', `task "${task.name}" requires unknown task "${ref}"`);
      }
    }
    expressions.set(task.name, ast);
  }

  if (!isPlainObject(spec.target)) {
    throw new PlanError('E_FIELD_TYPE', 'spec.target must be an object');
  }
  requireNonEmptyString(spec.target.artifact, 'spec.target.artifact');
  if (!ARTIFACT_TYPE_SET.has(spec.target.type)) {
    throw new PlanError(
      'E_ARTIFACT_TYPE',
      `spec.target.type must be one of ${ARTIFACT_TYPES.join(', ')}; got ${JSON.stringify(spec.target.type)}`,
    );
  }
  if (!producers.has(spec.target.artifact)) {
    throw new PlanError('E_MISSING_ARTIFACT', `no task produces target artifact "${spec.target.artifact}"`);
  }
  const actualType = producers.get(spec.target.artifact);
  if (actualType !== spec.target.type) {
    throw new PlanError(
      'E_TARGET_TYPE',
      `target artifact "${spec.target.artifact}" is produced as type "${actualType}", not "${spec.target.type}"`,
    );
  }

  return {
    name: spec.name,
    budget: spec.budget,
    tasks,
    target: { artifact: spec.target.artifact, type: spec.target.type },
    expressions,
  };
}
