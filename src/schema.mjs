// Input schema validation + normalization.
// Input JSON:
//   { "jobs": [{"id"?, "due", "work", "energy", "mold"}, ...],
//     "setup": {"MoldA": {"MoldB": <nonneg number>, ...}, ...},
//     "energyBudget": <nonneg number> }
// Normalized instance:
//   { jobs: [{id, due, work, energy, mold}], molds: [...], setup: number[][], energyBudget }

function err(error) {
  return { ok: false, error };
}

export function normalizeInstance(raw) {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    return err('instance must be a JSON object');
  }
  const { jobs, setup, energyBudget } = raw;

  if (!Array.isArray(jobs) || jobs.length === 0) {
    return err('jobs must be a non-empty array');
  }
  const normJobs = [];
  for (let i = 0; i < jobs.length; i++) {
    const j = jobs[i];
    if (j === null || typeof j !== 'object' || Array.isArray(j)) {
      return err(`jobs[${i}] must be an object`);
    }
    for (const f of ['due', 'work', 'energy']) {
      if (typeof j[f] !== 'number' || !Number.isFinite(j[f]) || j[f] < 0) {
        return err(`jobs[${i}].${f} must be a non-negative finite number`);
      }
    }
    if (typeof j.mold !== 'string' && typeof j.mold !== 'number') {
      return err(`jobs[${i}].mold must be a string or a number`);
    }
    normJobs.push({
      id: j.id !== undefined ? j.id : i,
      due: j.due,
      work: j.work,
      energy: j.energy,
      mold: String(j.mold),
    });
  }

  if (typeof energyBudget !== 'number' || !Number.isFinite(energyBudget) || energyBudget < 0) {
    return err('energyBudget must be a non-negative finite number');
  }

  const molds = [...new Set(normJobs.map((j) => j.mold))].sort();
  if (setup === null || typeof setup !== 'object' || Array.isArray(setup)) {
    return err('setup must be an object mapping mold -> mold -> changeover time');
  }
  const moldIndex = new Map(molds.map((m, i) => [m, i]));
  const matrix = molds.map(() => molds.map(() => 0));
  for (const a of molds) {
    const row = setup[a];
    if (row === null || typeof row !== 'object' || Array.isArray(row)) {
      return err(`setup[${JSON.stringify(a)}] must be an object mapping target mold -> time`);
    }
    for (const b of molds) {
      if (a === b) continue;
      const v = row[b];
      if (typeof v !== 'number' || !Number.isFinite(v) || v < 0) {
        return err(`setup[${JSON.stringify(a)}][${JSON.stringify(b)}] must be a non-negative finite number`);
      }
      matrix[moldIndex.get(a)][moldIndex.get(b)] = v;
    }
  }

  return { ok: true, instance: { jobs: normJobs, molds, setup: matrix, energyBudget } };
}
