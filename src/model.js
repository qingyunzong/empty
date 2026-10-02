export const DEFAULT_CONFIG = {
  runDuration: 60,
  cleanoutTime: 30,
  dayLength: 480,
  slotDuration: 15,
  compensationSlots: 1,
};

export function normalizeScenario(scenario) {
  const errors = [];
  if (scenario === null || typeof scenario !== 'object' || Array.isArray(scenario)) {
    return { errors: ['scenario must be an object'], config: null, recipes: new Map(), orders: [] };
  }

  const config = { ...DEFAULT_CONFIG, ...(scenario.config ?? {}) };
  for (const key of ['capacity', 'runDuration', 'cleanoutTime', 'dayLength', 'slotDuration']) {
    if (!Number.isFinite(config[key]) || config[key] <= 0) {
      errors.push(`config.${key} must be a positive number`);
    }
  }
  if (!Number.isInteger(config.compensationSlots) || config.compensationSlots < 0) {
    errors.push('config.compensationSlots must be a non-negative integer');
  }

  const recipes = new Map();
  for (const raw of scenario.recipes ?? []) {
    if (!raw || typeof raw.id !== 'string' || raw.id.length === 0) {
      errors.push('recipe missing id');
      continue;
    }
    if (recipes.has(raw.id)) {
      errors.push(`duplicate recipe id ${raw.id}`);
      continue;
    }
    const dailyQuota = raw.dailyQuota ?? Infinity;
    if (!(dailyQuota === Infinity || (Number.isFinite(dailyQuota) && dailyQuota >= 0))) {
      errors.push(`recipe ${raw.id}: dailyQuota must be a non-negative number`);
      continue;
    }
    recipes.set(raw.id, { id: raw.id, family: raw.family ?? raw.id, dailyQuota });
  }
  if (recipes.size === 0) errors.push('at least one recipe is required');

  const orders = [];
  const seen = new Set();
  for (const raw of scenario.orders ?? []) {
    const order = {
      id: raw?.id,
      recipe: raw?.recipe,
      qty: raw?.qty,
      due: raw?.due ?? 0,
      priority: raw?.priority ?? 'normal',
      arrival: raw?.arrival ?? 0,
      toolingPrepared: Boolean(raw?.toolingPrepared),
      splittable: raw?.splittable !== false,
      group: raw?.group ?? null,
    };
    if (typeof order.id !== 'string' || order.id.length === 0) {
      errors.push('order missing id');
      continue;
    }
    if (seen.has(order.id)) {
      errors.push(`duplicate order id ${order.id}`);
      continue;
    }
    seen.add(order.id);
    if (!recipes.has(order.recipe)) {
      errors.push(`order ${order.id}: unknown recipe ${order.recipe}`);
      continue;
    }
    if (!Number.isFinite(order.qty) || order.qty <= 0) {
      errors.push(`order ${order.id}: qty must be a positive number`);
      continue;
    }
    if (order.priority !== 'normal' && order.priority !== 'urgent') {
      errors.push(`order ${order.id}: priority must be "normal" or "urgent"`);
      continue;
    }
    orders.push(order);
  }

  if (errors.length === 0) {
    for (const order of orders) {
      if (!order.splittable && order.qty > config.capacity) {
        errors.push(
          `order ${order.id}: non-splittable qty ${order.qty} exceeds furnace capacity ${config.capacity}`,
        );
      }
      const quota = recipes.get(order.recipe).dailyQuota;
      if (order.qty > quota) {
        errors.push(`order ${order.id}: qty ${order.qty} exceeds daily quota ${quota} of recipe ${order.recipe}`);
      }
    }
    const groups = new Map();
    for (const order of orders) {
      if (!order.group) continue;
      if (!groups.has(order.group)) groups.set(order.group, []);
      groups.get(order.group).push(order);
    }
    for (const [gid, members] of groups) {
      const families = new Set(members.map((m) => recipes.get(m.recipe).family));
      if (families.size > 1) {
        errors.push(`group ${gid}: recipes are not compatible (families: ${[...families].join(', ')})`);
      }
      const total = members.reduce((sum, m) => sum + m.qty, 0);
      if (total > config.capacity) {
        errors.push(`group ${gid}: combined qty ${total} exceeds furnace capacity ${config.capacity}`);
      }
    }
  }

  return { errors, config, recipes, orders };
}
