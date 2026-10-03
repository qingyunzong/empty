import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { PlanError } from './errors.js';
import { validateSpec } from './validate.js';
import { findOptimalPlans } from './planner.js';
import { certificate } from './certificate.js';

export class ProjectStore {
  constructor(versions = []) {
    this.versions = versions.map((entry) => ({
      version: entry.version,
      spec: structuredClone(entry.spec),
    }));
  }

  get latestVersion() {
    return this.versions.length;
  }

  get(version) {
    const entry = this.versions.find((v) => v.version === version);
    if (!entry) {
      throw new PlanError('E_VERSION_NOT_FOUND', `version ${version} does not exist`);
    }
    return entry;
  }

  create(spec) {
    validateSpec(spec);
    const version = this.versions.length + 1;
    this.versions.push({ version, spec: structuredClone(spec) });
    return version;
  }

  revise(taskName, newCost, baseVersion) {
    const base = this.get(baseVersion ?? this.latestVersion);
    const task = base.spec.tasks.find((t) => t.name === taskName);
    if (!task) {
      throw new PlanError('E_MISSING_REF', `cannot revise: task "${taskName}" does not exist in version ${base.version}`);
    }
    if (typeof newCost !== 'number' || !Number.isFinite(newCost) || newCost < 0) {
      throw new PlanError('E_FIELD_TYPE', `new cost for task "${taskName}" must be a non-negative finite number`);
    }
    const next = structuredClone(base.spec);
    next.tasks.find((t) => t.name === taskName).cost = newCost;
    validateSpec(next);
    const version = this.versions.length + 1;
    this.versions.push({ version, spec: next });
    return version;
  }

  plan(version) {
    const entry = this.get(version ?? this.latestVersion);
    const validated = validateSpec(entry.spec);
    const plans = findOptimalPlans(validated);
    return {
      version: entry.version,
      budget: validated.budget,
      target: validated.target,
      plans,
      certificate: certificate({ version: entry.version, spec: entry.spec, plans }),
    };
  }
}

export function loadStore(path) {
  let raw;
  try {
    raw = readFileSync(path, 'utf8');
  } catch (err) {
    if (err.code === 'ENOENT') {
      throw new PlanError('E_STATE_NOT_FOUND', `state file not found: ${path}; run "create" first`);
    }
    throw err;
  }
  let data;
  try {
    data = JSON.parse(raw);
  } catch {
    throw new PlanError('E_STATE_CORRUPT', `state file is not valid JSON: ${path}`);
  }
  if (!data || !Array.isArray(data.versions)) {
    throw new PlanError('E_STATE_CORRUPT', `state file has no versions array: ${path}`);
  }
  return new ProjectStore(data.versions);
}

export function saveStore(path, store) {
  mkdirSync(dirname(path), { recursive: true });
  const data = { versions: store.versions };
  writeFileSync(path, `${JSON.stringify(data, null, 2)}\n`);
}
