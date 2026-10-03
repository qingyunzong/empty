/** Data model: config / order normalization and feasibility validation. */

export class PlanError extends Error {
  constructor(message) {
    super(message);
    this.name = 'PlanError';
  }
}

function ensureNumber(value, name, { min = 0, integer = true } = {}) {
  if (typeof value !== 'number' || Number.isNaN(value) || value < min) {
    throw new PlanError(`${name} must be a number >= ${min}, got ${JSON.stringify(value)}`);
  }
  if (integer && !Number.isInteger(value)) {
    throw new PlanError(`${name} must be an integer, got ${value}`);
  }
  return value;
}

export function normalizeConfig(raw) {
  if (!raw || typeof raw !== 'object') throw new PlanError('config must be an object');
  const cfg = {
    capacity: ensureNumber(raw.capacity, 'config.capacity', { min: 1 }),
    runTime: ensureNumber(raw.runTime ?? 1, 'config.runTime', { min: 1 }),
    cleanTime: ensureNumber(raw.cleanTime ?? 0, 'config.cleanTime', { min: 0 }),
    dayLength: ensureNumber(raw.dayLength ?? 24, 'config.dayLength', { min: 1 }),
    compensationSlots: ensureNumber(raw.compensationSlots ?? 0, 'config.compensationSlots', { min: 0 }),
    agingRate: ensureNumber(raw.agingRate ?? 0, 'config.agingRate', { min: 0 }),
    supportedGroups: raw.supportedGroups ?? null,
    recipes: raw.recipes ?? {},
  };
  if (cfg.supportedGroups !== null && !Array.isArray(cfg.supportedGroups)) {
    throw new PlanError('config.supportedGroups must be an array or null');
  }
  if (typeof cfg.recipes !== 'object' || Array.isArray(cfg.recipes)) {
    throw new PlanError('config.recipes must be an object');
  }
  for (const [name, r] of Object.entries(cfg.recipes)) {
    if (!r || typeof r !== 'object') throw new PlanError(`recipes.${name} must be an object`);
    if (typeof r.group !== 'string' || r.group.length === 0) {
      throw new PlanError(`recipes.${name}.group must be a non-empty string`);
    }
    ensureNumber(r.dailyQuota, `recipes.${name}.dailyQuota`, { min: 0 });
  }
  return cfg;
}

export function normalizeOrder(raw, defaultArrival = 0) {
  if (!raw || typeof raw !== 'object') throw new PlanError('order must be an object');
  if (raw.id === undefined || raw.id === null) throw new PlanError('order.id is required');
  return {
    id: String(raw.id),
    recipe: raw.recipe,
    batches: raw.batches ?? 1,
    batchSize: raw.batchSize ?? 1,
    due: raw.due ?? 0,
    priority: raw.priority === 'urgent' ? 'urgent' : 'normal',
    arrival: raw.arrival ?? defaultArrival,
  };
}

/**
 * Validate orders against the furnace config.
 * Returns a list of human-readable errors (empty means feasible).
 */
export function validateOrders(cfg, orders, { existingIds = new Set() } = {}) {
  const errors = [];
  const seen = new Set(existingIds);
  for (const o of orders) {
    if (seen.has(o.id)) {
      errors.push(`order ${o.id}: duplicate order id`);
      continue;
    }
    seen.add(o.id);
    if (typeof o.recipe !== 'string' || !cfg.recipes[o.recipe]) {
      errors.push(`order ${o.id}: unknown recipe ${JSON.stringify(o.recipe)}`);
      continue;
    }
    const r = cfg.recipes[o.recipe];
    if (cfg.supportedGroups && !cfg.supportedGroups.includes(r.group)) {
      errors.push(
        `order ${o.id}: recipe group "${r.group}" is not compatible with this furnace ` +
        `(supported: ${cfg.supportedGroups.join(', ')})`
      );
    }
    if (!Number.isInteger(o.batches) || o.batches < 1) {
      errors.push(`order ${o.id}: batches must be a positive integer, got ${JSON.stringify(o.batches)}`);
    }
    if (!Number.isInteger(o.batchSize) || o.batchSize < 1) {
      errors.push(`order ${o.id}: batchSize must be a positive integer, got ${JSON.stringify(o.batchSize)}`);
    } else if (o.batchSize > cfg.capacity) {
      errors.push(
        `order ${o.id}: batch size ${o.batchSize} exceeds furnace capacity ${cfg.capacity}`
      );
    } else if (r.dailyQuota < o.batchSize) {
      errors.push(
        `order ${o.id}: daily quota of recipe ${o.recipe} (${r.dailyQuota}) can never fit one batch of size ${o.batchSize}`
      );
    }
    if (typeof o.due !== 'number' || Number.isNaN(o.due)) {
      errors.push(`order ${o.id}: due must be a number`);
    }
  }
  return errors;
}
