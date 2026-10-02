// Shared problem semantics. Both the backtracking solver and the brute-force
// enumerator use these primitives so their feasibility models cannot drift.

export class ModelError extends Error {}

export function rampClass(temp, dur) {
  // Heating-rate tier of a (temperature tier, duration tier) pair.
  return Math.ceil(temp / dur);
}

export function numBatches(config) {
  return config.days * config.maxRunsPerDay;
}

export function dayOfBatch(config, batch) {
  return Math.floor(batch / config.maxRunsPerDay);
}

export function recipeValues(recipe) {
  const values = [];
  for (const temp of recipe.temps) {
    for (const atmo of recipe.atmos) {
      for (const dur of recipe.durs) {
        values.push({ temp, atmo, dur });
      }
    }
  }
  return values;
}

export function gasOf(config, value) {
  return config.gasUsage[value.atmo] ?? 0;
}

export function createBatchState(config) {
  return {
    batches: Array.from({ length: numBatches(config) }, () => ({
      members: [], // [{ id, crucible, value, ramp }]
      crucibleUse: new Map(), // crucible type -> count
    })),
    dayGas: Array(config.days).fill(0),
  };
}

export function canAssign(config, state, recipe, value, batch) {
  const b = state.batches[batch];
  if (!b) return false;
  if (b.members.length >= config.slots) return false;
  const cap = config.crucibles[recipe.crucible];
  if (cap === undefined) return false;
  if ((b.crucibleUse.get(recipe.crucible) ?? 0) + 1 > cap) return false;
  const ramp = rampClass(value.temp, value.dur);
  for (const m of b.members) {
    if (Math.abs(m.value.temp - value.temp) > config.maxTempDiff) return false;
    if (m.ramp !== ramp) return false;
    for (const group of config.hazards) {
      if (
        m.value.atmo !== value.atmo &&
        group.includes(m.value.atmo) &&
        group.includes(value.atmo)
      ) {
        return false;
      }
    }
  }
  const day = dayOfBatch(config, batch);
  if (state.dayGas[day] + gasOf(config, value) > config.gasBudget) return false;
  return true;
}

export function assign(config, state, recipe, value, batch) {
  const b = state.batches[batch];
  b.members.push({ id: recipe.id, crucible: recipe.crucible, value, ramp: rampClass(value.temp, value.dur) });
  b.crucibleUse.set(recipe.crucible, (b.crucibleUse.get(recipe.crucible) ?? 0) + 1);
  state.dayGas[dayOfBatch(config, batch)] += gasOf(config, value);
}

export function unassign(config, state, recipe, value, batch) {
  const b = state.batches[batch];
  const idx = b.members.findIndex((m) => m.id === recipe.id);
  b.members.splice(idx, 1);
  b.crucibleUse.set(recipe.crucible, b.crucibleUse.get(recipe.crucible) - 1);
  state.dayGas[dayOfBatch(config, batch)] -= gasOf(config, value);
}

// Solution ordering: maximize priority weight; ties broken by the
// lexicographically smaller sorted list of scheduled recipe IDs
// (shorter list wins when one is a prefix of the other).
export function isBetterSolution(a, b) {
  if (a.weight !== b.weight) return a.weight > b.weight;
  const n = Math.min(a.ids.length, b.ids.length);
  for (let i = 0; i < n; i++) {
    if (a.ids[i] !== b.ids[i]) return a.ids[i] < b.ids[i];
  }
  return a.ids.length < b.ids.length;
}

export function validateConfig(config) {
  const fail = (msg) => { throw new ModelError(`invalid config: ${msg}`); };
  if (!config || typeof config !== 'object') fail('missing');
  for (const k of ['days', 'maxRunsPerDay', 'slots']) {
    if (!Number.isInteger(config[k]) || config[k] < 1) fail(`${k} must be a positive integer`);
  }
  if (!Number.isFinite(config.gasBudget) || config.gasBudget < 0) fail('gasBudget must be >= 0');
  if (!Number.isInteger(config.maxTempDiff) || config.maxTempDiff < 0) fail('maxTempDiff must be an integer >= 0');
  if (!config.crucibles || typeof config.crucibles !== 'object') fail('crucibles must be an object');
  for (const [k, v] of Object.entries(config.crucibles)) {
    if (!Number.isInteger(v) || v < 0) fail(`crucibles.${k} must be an integer >= 0`);
  }
  if (!config.gasUsage || typeof config.gasUsage !== 'object') fail('gasUsage must be an object');
  for (const [k, v] of Object.entries(config.gasUsage)) {
    if (!Number.isFinite(v) || v < 0) fail(`gasUsage.${k} must be >= 0`);
  }
  if (!Array.isArray(config.hazards)) fail('hazards must be an array of atmosphere groups');
  for (const g of config.hazards) {
    if (!Array.isArray(g) || g.length < 2) fail('each hazard group needs >= 2 atmospheres');
  }
  if (config.requiredPriority !== undefined && !Number.isFinite(config.requiredPriority)) {
    fail('requiredPriority must be a number');
  }
}

export function validateRecipe(recipe) {
  const fail = (msg) => { throw new ModelError(`invalid recipe ${recipe?.id ?? '?'}: ${msg}`); };
  if (!recipe || typeof recipe.id !== 'string' || recipe.id.length === 0) fail('id must be a non-empty string');
  if (!Number.isFinite(recipe.priority) || recipe.priority < 0) fail('priority must be >= 0');
  for (const k of ['temps', 'durs']) {
    if (!Array.isArray(recipe[k]) || recipe[k].length === 0 || !recipe[k].every((v) => Number.isInteger(v) && v >= 1)) {
      fail(`${k} must be a non-empty array of positive integers`);
    }
  }
  if (!Array.isArray(recipe.atmos) || recipe.atmos.length === 0 || !recipe.atmos.every((a) => typeof a === 'string' && a.length > 0)) {
    fail('atmos must be a non-empty array of strings');
  }
  if (typeof recipe.crucible !== 'string' || recipe.crucible.length === 0) fail('crucible must be a non-empty string');
}
