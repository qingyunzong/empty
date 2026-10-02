// Input normalization and order-level validation.
// Structural problems throw TypeError; per-order problems are collected as
// error records so valid orders in the same input can still be scheduled.

function series(value, shifts, label) {
  if (typeof value === 'number') {
    if (!Number.isFinite(value) || value < 0) {
      throw new TypeError(`${label} must be a non-negative finite number`);
    }
    return new Array(shifts).fill(value);
  }
  if (Array.isArray(value)) {
    if (value.length !== shifts) {
      throw new TypeError(`${label} array must have exactly ${shifts} entries (one per shift)`);
    }
    return value.map((entry, index) => {
      if (typeof entry !== 'number' || !Number.isFinite(entry) || entry < 0) {
        throw new TypeError(`${label}[${index}] must be a non-negative finite number`);
      }
      return entry;
    });
  }
  throw new TypeError(`${label} must be a number or an array of ${shifts} numbers`);
}

export function normalizeInput(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new TypeError('input must be a JSON object');
  }
  const { shifts } = input;
  if (!Number.isInteger(shifts) || shifts < 1) {
    throw new TypeError('"shifts" must be a positive integer');
  }
  if (!Array.isArray(input.lines) || input.lines.length === 0) {
    throw new TypeError('"lines" must be a non-empty array');
  }
  if (!Array.isArray(input.stations) || input.stations.length === 0) {
    throw new TypeError('"stations" must be a non-empty array');
  }
  if (!Array.isArray(input.orders)) {
    throw new TypeError('"orders" must be an array');
  }

  const lines = new Map();
  for (const line of input.lines) {
    if (!line || typeof line.id !== 'string' || line.id === '') {
      throw new TypeError('each line needs a non-empty string "id"');
    }
    if (lines.has(line.id)) {
      throw new TypeError(`duplicate line id "${line.id}"`);
    }
    lines.set(line.id, {
      id: line.id,
      budget: series(line.budgetPerShift, shifts, `line "${line.id}" budgetPerShift`),
    });
  }

  const stations = new Map();
  for (const station of input.stations) {
    if (!station || typeof station.id !== 'string' || station.id === '') {
      throw new TypeError('each station needs a non-empty string "id"');
    }
    if (stations.has(station.id)) {
      throw new TypeError(`duplicate station id "${station.id}"`);
    }
    if (!lines.has(station.lineId)) {
      throw new TypeError(`station "${station.id}" references unknown line "${station.lineId}"`);
    }
    stations.set(station.id, {
      id: station.id,
      lineId: station.lineId,
      capacity: series(station.capacityPerShift, shifts, `station "${station.id}" capacityPerShift`),
    });
  }

  const orders = [];
  const seenOrderIds = new Set();
  for (const raw of input.orders) {
    if (!raw || typeof raw.id !== 'string' || raw.id === '') {
      throw new TypeError('each order needs a non-empty string "id"');
    }
    if (seenOrderIds.has(raw.id)) {
      throw new TypeError(`duplicate order id "${raw.id}"`);
    }
    seenOrderIds.add(raw.id);
    const priority = raw.priority ?? 'normal';
    if (priority !== 'high' && priority !== 'normal') {
      throw new TypeError(`order "${raw.id}" priority must be "high" or "normal"`);
    }
    const arrivalShift = raw.arrivalShift ?? 0;
    if (!Number.isInteger(arrivalShift) || arrivalShift < 0 || arrivalShift >= shifts) {
      throw new TypeError(`order "${raw.id}" arrivalShift must be an integer in [0, ${shifts - 1}]`);
    }
    if (!Array.isArray(raw.route) || raw.route.length === 0) {
      throw new TypeError(`order "${raw.id}" route must be a non-empty array`);
    }
    const route = raw.route.map((step) => ({
      station: step && typeof step === 'object' ? step.station : undefined,
      minutes: step && typeof step === 'object' ? step.minutes : undefined,
    }));
    orders.push({ id: raw.id, priority, arrivalShift, route });
  }

  return { shifts, lines, stations, orders };
}

// Per-order validation. Invalid orders are excluded from scheduling and
// reported with a machine-readable code.
export function validateOrders(norm) {
  const valid = [];
  const errors = [];
  for (const order of norm.orders) {
    let problem = null;
    for (let stepIndex = 0; stepIndex < order.route.length && !problem; stepIndex += 1) {
      const step = order.route[stepIndex];
      if (typeof step.minutes !== 'number' || !Number.isFinite(step.minutes)) {
        problem = { code: 'invalid-minutes', message: `step ${stepIndex} minutes must be a finite number` };
      } else if (step.minutes <= 0) {
        problem = { code: 'negative-minutes', message: `step ${stepIndex} minutes must be positive, got ${step.minutes}` };
      } else if (!norm.stations.has(step.station)) {
        problem = { code: 'unknown-station', message: `step ${stepIndex} references unknown station "${step.station}"` };
      } else {
        const station = norm.stations.get(step.station);
        const line = norm.lines.get(station.lineId);
        const maxBudget = Math.max(...line.budget);
        if (step.minutes > maxBudget) {
          problem = {
            code: 'over-budget',
            message: `step ${stepIndex} needs ${step.minutes} labor minutes but line "${line.id}" budget never exceeds ${maxBudget}`,
          };
        }
      }
    }
    if (problem) {
      errors.push({ orderId: order.id, code: problem.code, message: `order "${order.id}": ${problem.message}` });
    } else {
      valid.push(order);
    }
  }
  return { valid, errors };
}
