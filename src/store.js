import { solve } from './solver.js';
import { ModelError, numBatches, validateConfig, validateRecipe } from './model.js';

export class StoreError extends Error {}

export class Store {
  constructor(state = null, snapshots = []) {
    this.state = state ?? { config: null, recipes: [], locks: [], result: null };
    this.snapshots = snapshots;
  }

  toJSON() {
    return { state: this.state, snapshots: this.snapshots };
  }

  static fromJSON(obj) {
    return new Store(obj?.state ?? null, obj?.snapshots ?? []);
  }

  init(config) {
    validateConfig(config);
    this.state.config = config;
    this.state.result = null;
  }

  addRecipe(recipe) {
    if (this.state.recipes.some((r) => r.id === recipe.id)) {
      throw new StoreError(`duplicate recipe id: ${recipe.id}`);
    }
    validateRecipe(recipe);
    this.state.recipes.push(recipe);
    this.state.result = null;
  }

  lock(recipeId, slot) {
    const recipe = this.state.recipes.find((r) => r.id === recipeId);
    if (!recipe) throw new StoreError(`unknown recipe: ${recipeId}`);
    if (this.state.locks.some((l) => l.recipe === recipeId)) {
      throw new StoreError(`already locked: ${recipeId}`);
    }
    if (this.state.result?.assignment?.[recipeId]) {
      throw new StoreError(`cannot lock scheduled variable: ${recipeId}`);
    }
    if (!this.state.config) throw new StoreError('not initialized: run init first');
    const { batch, temp, atmo, dur } = slot;
    if (!Number.isInteger(batch) || batch < 0 || batch >= numBatches(this.state.config)) {
      throw new StoreError(`batch out of range: ${batch}`);
    }
    if (!recipe.temps.includes(temp)) throw new StoreError(`temp ${temp} not in domain of ${recipeId}`);
    if (!recipe.atmos.includes(atmo)) throw new StoreError(`atmo ${atmo} not in domain of ${recipeId}`);
    if (!recipe.durs.includes(dur)) throw new StoreError(`dur ${dur} not in domain of ${recipeId}`);
    this.state.locks.push({ recipe: recipeId, batch, temp, atmo, dur });
    this.state.result = null;
  }

  unlock(recipeId) {
    const idx = this.state.locks.findIndex((l) => l.recipe === recipeId);
    if (idx < 0) throw new StoreError(`not locked: ${recipeId}`);
    this.state.locks.splice(idx, 1);
    // Unlocking invalidates the incumbent schedule: the next optimize call
    // recomputes from scratch over the remaining locks.
    this.state.result = null;
  }

  snapshot() {
    this.snapshots.push(structuredClone(this.state));
    return this.snapshots.length;
  }

  restore() {
    if (this.snapshots.length === 0) throw new StoreError('snapshot stack empty');
    // Stack discipline: restoring pops the latest snapshot; every snapshot
    // taken after it (the "future" ones) is discarded with the pop.
    this.state = this.snapshots.pop();
    return this.snapshots.length;
  }

  optimize(budgets = {}) {
    if (!this.state.config) throw new StoreError('not initialized: run init first');
    const result = solve(
      { config: this.state.config, recipes: this.state.recipes, locks: this.state.locks },
      budgets,
    );
    // Only definitive results become the incumbent schedule; a PENDING
    // partial result is returned to the caller but never cached.
    if (result.status !== 'PENDING') {
      this.state.result = result;
    }
    return result;
  }
}

export { ModelError };
