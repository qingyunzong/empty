export const DEFAULT_CONFIG = {
  days: 3,
  maxRunsPerDay: 2,
  slotsPerRun: 4,
  tempDelta: 150,
  gasBudget: 24,
  crucibles: { alumina: 4, graphite: 2 },
  rampProfiles: { standard: { maxRamp: 10 }, fast: { maxRamp: 20 } },
  hazardous: ['H2', 'CO'],
  minCoverage: 0,
};

export const DEFAULT_BUDGETS = {
  propagation: 100000,
  backtrack: 100000,
  improvement: 10000,
};

export class StateError extends Error {
  constructor(message) {
    super(message);
    this.name = 'StateError';
  }
}

const clone = (value) => structuredClone(value);

export function createState() {
  return {
    config: clone(DEFAULT_CONFIG),
    budgets: { ...DEFAULT_BUDGETS },
    recipes: [],
    locks: {},
    snapshots: [],
    nextSnapshotId: 1,
    lastSolution: null,
  };
}

export function maxRuns(config) {
  return config.days * config.maxRunsPerDay;
}

function isFiniteNumber(value) {
  return typeof value === 'number' && Number.isFinite(value);
}

function normalizeRecipe(recipe) {
  if (!recipe || typeof recipe !== 'object' || Array.isArray(recipe)) {
    throw new StateError('recipe must be an object');
  }
  const {
    id,
    priority = 1,
    temps,
    atmospheres,
    durations,
    crucible,
    gasPerHour = 1,
    rampRequired = 0,
  } = recipe;
  if (typeof id !== 'string' || id.length === 0) {
    throw new StateError('recipe.id must be a non-empty string');
  }
  if (!isFiniteNumber(priority) || priority < 0) {
    throw new StateError(`recipe ${id}: priority must be a non-negative number`);
  }
  if (!Array.isArray(temps) || temps.length === 0 || !temps.every(isFiniteNumber)) {
    throw new StateError(`recipe ${id}: temps must be a non-empty array of numbers`);
  }
  if (
    !Array.isArray(atmospheres) ||
    atmospheres.length === 0 ||
    !atmospheres.every((a) => typeof a === 'string' && a.length > 0)
  ) {
    throw new StateError(`recipe ${id}: atmospheres must be a non-empty array of strings`);
  }
  if (
    !Array.isArray(durations) ||
    durations.length === 0 ||
    !durations.every((d) => isFiniteNumber(d) && d > 0)
  ) {
    throw new StateError(`recipe ${id}: durations must be a non-empty array of positive numbers`);
  }
  if (typeof crucible !== 'string' || crucible.length === 0) {
    throw new StateError(`recipe ${id}: crucible must be a non-empty string`);
  }
  if (!isFiniteNumber(gasPerHour) || gasPerHour < 0) {
    throw new StateError(`recipe ${id}: gasPerHour must be a non-negative number`);
  }
  if (!isFiniteNumber(rampRequired) || rampRequired < 0) {
    throw new StateError(`recipe ${id}: rampRequired must be a non-negative number`);
  }
  const dedupeSort = (arr, cmp) => [...new Set(arr)].sort(cmp);
  return {
    id,
    priority,
    temps: dedupeSort(temps, (a, b) => a - b),
    atmospheres: dedupeSort(atmospheres),
    durations: dedupeSort(durations, (a, b) => a - b),
    crucible,
    gasPerHour,
    rampRequired,
  };
}

export function addRecipe(state, recipe) {
  const normalized = normalizeRecipe(recipe);
  if (state.recipes.some((r) => r.id === normalized.id)) {
    throw new StateError(`duplicate recipe id: ${normalized.id}`);
  }
  state.recipes.push(normalized);
  state.lastSolution = null;
  return normalized;
}

export function lockSlot(state, recipeId, lock) {
  const recipe = state.recipes.find((r) => r.id === recipeId);
  if (!recipe) {
    throw new StateError(`unknown recipe: ${recipeId}`);
  }
  if (
    state.lastSolution &&
    Array.isArray(state.lastSolution.scheduled) &&
    state.lastSolution.scheduled.some((s) => s.recipe === recipeId)
  ) {
    throw new StateError(`cannot lock already scheduled variable: ${recipeId}`);
  }
  if (!lock || typeof lock !== 'object') {
    throw new StateError('lock must be an object with run/temp/atmosphere/duration');
  }
  const { run, temp, atmosphere, duration } = lock;
  if (!Number.isInteger(run) || run < 0 || run >= maxRuns(state.config)) {
    throw new StateError(`lock run out of range: ${run} (maxRuns=${maxRuns(state.config)})`);
  }
  if (!recipe.temps.includes(temp)) {
    throw new StateError(`lock temp ${temp} not in domain of ${recipeId}`);
  }
  if (!recipe.atmospheres.includes(atmosphere)) {
    throw new StateError(`lock atmosphere ${atmosphere} not in domain of ${recipeId}`);
  }
  if (!recipe.durations.includes(duration)) {
    throw new StateError(`lock duration ${duration} not in domain of ${recipeId}`);
  }
  state.locks[recipeId] = { run, temp, atmosphere, duration };
  state.lastSolution = null;
  return state.locks[recipeId];
}

export function unlockSlot(state, recipeId) {
  if (!Object.prototype.hasOwnProperty.call(state.locks, recipeId)) {
    throw new StateError(`no lock on recipe: ${recipeId}`);
  }
  delete state.locks[recipeId];
  // Unlocking invalidates any previously computed schedule and forces a
  // full re-schedule on the next optimize call.
  state.lastSolution = null;
}

export function snapshot(state) {
  const id = state.nextSnapshotId++;
  state.snapshots.push({
    id,
    data: clone({
      config: state.config,
      budgets: state.budgets,
      recipes: state.recipes,
      locks: state.locks,
      lastSolution: state.lastSolution,
    }),
  });
  return id;
}

export function restore(state, id) {
  if (state.snapshots.length === 0) {
    throw new StateError('no snapshots available');
  }
  const target = id ?? state.snapshots[state.snapshots.length - 1].id;
  const index = state.snapshots.findIndex((s) => s.id === target);
  if (index === -1) {
    throw new StateError(`snapshot expired or unknown: ${target}`);
  }
  const { data } = state.snapshots[index];
  state.config = clone(data.config);
  state.budgets = clone(data.budgets);
  state.recipes = clone(data.recipes);
  state.locks = clone(data.locks);
  state.lastSolution = clone(data.lastSolution);
  // Restoring invalidates the restored snapshot and every later snapshot.
  state.snapshots.length = index;
  return target;
}

function validateConfig(config) {
  for (const key of ['days', 'maxRunsPerDay', 'slotsPerRun']) {
    if (!Number.isInteger(config[key]) || config[key] < 1) {
      throw new StateError(`config.${key} must be a positive integer`);
    }
  }
  for (const key of ['tempDelta', 'gasBudget', 'minCoverage']) {
    if (!isFiniteNumber(config[key]) || config[key] < 0) {
      throw new StateError(`config.${key} must be a non-negative number`);
    }
  }
  if (!config.crucibles || typeof config.crucibles !== 'object') {
    throw new StateError('config.crucibles must be an object of type -> count');
  }
  for (const [type, count] of Object.entries(config.crucibles)) {
    if (!Number.isInteger(count) || count < 0) {
      throw new StateError(`config.crucibles.${type} must be a non-negative integer`);
    }
  }
  if (!config.rampProfiles || typeof config.rampProfiles !== 'object') {
    throw new StateError('config.rampProfiles must be an object of name -> {maxRamp}');
  }
  if (!Array.isArray(config.hazardous)) {
    throw new StateError('config.hazardous must be an array of atmosphere names');
  }
}

export function configure(state, patch) {
  if (!patch || typeof patch !== 'object' || Array.isArray(patch)) {
    throw new StateError('config patch must be an object');
  }
  const { budgets, ...configPatch } = patch;
  Object.assign(state.config, clone(configPatch));
  validateConfig(state.config);
  if (budgets !== undefined) {
    if (!budgets || typeof budgets !== 'object') {
      throw new StateError('budgets must be an object');
    }
    for (const key of ['propagation', 'backtrack', 'improvement']) {
      if (budgets[key] !== undefined) {
        if (!isFiniteNumber(budgets[key]) || budgets[key] < 0) {
          throw new StateError(`budgets.${key} must be a non-negative number`);
        }
        state.budgets[key] = budgets[key];
      }
    }
  }
  state.lastSolution = null;
}
