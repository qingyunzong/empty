import { PlannerError, CODES } from './errors.js';
import { validateSpec } from './spec.js';

// Versioned store. Versions are immutable once committed; a failed
// validation never mutates the store, so no half-built state is kept.
export class PlannerStore {
  constructor() {
    this.versions = []; // 1-based externally
  }

  get versionCount() {
    return this.versions.length;
  }

  addVersion(rawSpec) {
    const norm = validateSpec(rawSpec); // throws before any mutation
    this.versions.push({ spec: norm, raw: structuredClone(rawSpec) });
    return this.versions.length;
  }

  getVersion(version) {
    if (!Number.isInteger(version) || version < 1 || version > this.versions.length) {
      throw new PlannerError(CODES.UNKNOWN_VERSION, `unknown version ${version}; store has ${this.versions.length} version(s)`);
    }
    return this.versions[version - 1].spec;
  }

  getRawSpec(version) {
    if (!Number.isInteger(version) || version < 1 || version > this.versions.length) {
      throw new PlannerError(CODES.UNKNOWN_VERSION, `unknown version ${version}; store has ${this.versions.length} version(s)`);
    }
    return structuredClone(this.versions[version - 1].raw);
  }

  // Creates a new version identical to `version` except one task's cost.
  // The old version is preserved. Throws (and adds nothing) if the task is
  // missing, the cost is invalid, or the revised spec fails validation.
  revise(version, taskName, newCost) {
    const raw = this.getRawSpec(version);
    const task = raw.tasks.find((t) => t.name === taskName);
    if (!task) {
      throw new PlannerError(CODES.UNKNOWN_TASK, `version ${version} has no task named ${JSON.stringify(taskName)}`);
    }
    task.cost = newCost; // validateSpec enforces numeric/finite/>=0
    return this.addVersion(raw);
  }

  toJSON() {
    return { versions: this.versions.map((v) => v.raw) };
  }

  static fromJSON(data) {
    const store = new PlannerStore();
    if (!data || !Array.isArray(data.versions)) {
      throw new PlannerError(CODES.SPEC_SHAPE, 'store file must contain { "versions": [...] }');
    }
    for (const raw of data.versions) store.addVersion(raw);
    return store;
  }
}
