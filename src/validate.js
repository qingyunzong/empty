export class SchemaError extends Error {
  constructor(message) {
    super(message);
    this.name = 'SchemaError';
    this.code = 'ERR_SCHEMA';
  }
}

const isNonNegNumber = (v) => typeof v === 'number' && Number.isFinite(v) && v >= 0;

/**
 * Validate a raw JSON instance and return a canonical form:
 *   { jobs: [{id, due, work, energy, mold, moldIdx}], molds: [...], setup: [[..]], energyBudget }
 * Throws SchemaError (code ERR_SCHEMA) on any violation.
 */
export function validateInstance(raw) {
  const fail = (msg) => { throw new SchemaError(msg); };
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) fail('root must be an object');
  const { jobs, setup, energyBudget } = raw;

  if (!Array.isArray(jobs)) fail('jobs must be an array');
  jobs.forEach((job, i) => {
    if (job === null || typeof job !== 'object' || Array.isArray(job)) fail(`jobs[${i}] must be an object`);
    for (const key of ['due', 'work', 'energy']) {
      if (!isNonNegNumber(job[key])) fail(`jobs[${i}].${key} must be a non-negative finite number`);
    }
    if (typeof job.mold !== 'string' && typeof job.mold !== 'number') fail(`jobs[${i}].mold must be a string or number`);
    if (job.id !== undefined && typeof job.id !== 'string' && typeof job.id !== 'number') {
      fail(`jobs[${i}].id must be a string or number`);
    }
  });

  if (!isNonNegNumber(energyBudget)) fail('energyBudget must be a non-negative finite number');

  const molds = [...new Set(jobs.map((j) => String(j.mold)))].sort();
  if (!Array.isArray(setup)) fail('setup must be a 2D array');
  if (setup.length !== molds.length) {
    fail(`setup must have exactly ${molds.length} row(s) (one per distinct mold), got ${setup.length}`);
  }
  setup.forEach((row, r) => {
    if (!Array.isArray(row) || row.length !== molds.length) {
      fail(`setup[${r}] must be an array of length ${molds.length}`);
    }
    row.forEach((v, c) => {
      if (!isNonNegNumber(v)) fail(`setup[${r}][${c}] must be a non-negative finite number`);
    });
  });

  const moldIndex = new Map(molds.map((m, i) => [m, i]));
  const canonJobs = jobs.map((job, i) => ({
    id: job.id === undefined ? `J${i}` : String(job.id),
    due: job.due,
    work: job.work,
    energy: job.energy,
    mold: String(job.mold),
    moldIdx: moldIndex.get(String(job.mold)),
  }));
  if (new Set(canonJobs.map((j) => j.id)).size !== canonJobs.length) fail('job ids must be unique');

  return { jobs: canonJobs, molds, setup: setup.map((r) => r.slice()), energyBudget };
}
