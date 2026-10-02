// Schedule verification and exhaustive route-timing enumeration.
// enumerateAssignments is intended for small inputs (<= 4 orders): it
// brute-forces every non-decreasing shift vector per order and keeps only
// assignments that respect station capacity and line budget per shift.

export function verifySchedule(norm, result) {
  const violations = [];
  const stationUsed = new Map([...norm.stations.keys()].map((id) => [id, new Array(norm.shifts).fill(0)]));
  const lineUsed = new Map([...norm.lines.keys()].map((id) => [id, new Array(norm.shifts).fill(0)]));
  const orderById = new Map(norm.orders.map((order) => [order.id, order]));
  const routed = new Set();

  for (const route of result.routes) {
    const order = orderById.get(route.orderId);
    if (!order) {
      violations.push(`route references unknown order "${route.orderId}"`);
      continue;
    }
    if (routed.has(route.orderId)) {
      violations.push(`order "${route.orderId}" has more than one route`);
      continue;
    }
    routed.add(route.orderId);
    if (route.steps.length !== order.route.length) {
      violations.push(`order "${route.orderId}" has ${route.steps.length} steps, expected ${order.route.length}`);
      continue;
    }
    let minShift = order.arrivalShift;
    for (const step of route.steps) {
      const wanted = order.route[step.stepIndex];
      if (!wanted) {
        violations.push(`order "${route.orderId}" step ${step.stepIndex} out of range`);
        continue;
      }
      if (step.station !== wanted.station || step.minutes !== wanted.minutes) {
        violations.push(`order "${route.orderId}" step ${step.stepIndex} does not match its route definition`);
        continue;
      }
      if (!Number.isInteger(step.shift) || step.shift < minShift || step.shift >= norm.shifts) {
        violations.push(
          `order "${route.orderId}" step ${step.stepIndex} has invalid shift ${step.shift} (must be >= ${minShift} and < ${norm.shifts})`,
        );
        continue;
      }
      minShift = step.shift;
      stationUsed.get(step.station)[step.shift] += step.minutes;
      lineUsed.get(step.lineId)[step.shift] += step.minutes;
    }
  }

  for (const orderId of result.waiting) {
    if (routed.has(orderId)) violations.push(`order "${orderId}" is both routed and waiting`);
  }
  for (const error of result.errors) {
    if (routed.has(error.orderId)) violations.push(`order "${error.orderId}" is both routed and errored`);
  }

  for (const [id, used] of stationUsed) {
    const { capacity } = norm.stations.get(id);
    for (let shift = 0; shift < norm.shifts; shift += 1) {
      if (used[shift] > capacity[shift]) {
        violations.push(`station "${id}" shift ${shift} used ${used[shift]} > capacity ${capacity[shift]}`);
      }
    }
  }
  for (const [id, used] of lineUsed) {
    const { budget } = norm.lines.get(id);
    for (let shift = 0; shift < norm.shifts; shift += 1) {
      if (used[shift] > budget[shift]) {
        violations.push(`line "${id}" shift ${shift} used ${used[shift]} > budget ${budget[shift]}`);
      }
    }
  }

  return { ok: violations.length === 0, violations };
}

function shiftVectors(order, shifts) {
  const vectors = [];
  const current = new Array(order.route.length);
  const walk = (stepIndex, minShift) => {
    if (stepIndex === order.route.length) {
      vectors.push([...current]);
      return;
    }
    for (let shift = minShift; shift < shifts; shift += 1) {
      current[stepIndex] = shift;
      walk(stepIndex + 1, shift);
    }
  };
  walk(0, order.arrivalShift);
  return vectors;
}

// Enumerates every feasible timing assignment for the given orders.
// Returns { orders, assignments, truncated } where each assignment is an
// array of shift vectors aligned with `orders`.
export function enumerateAssignments(norm, orderIds, { limit = 20000 } = {}) {
  const orders = orderIds.map((id) => {
    const order = norm.orders.find((candidate) => candidate.id === id);
    if (!order) throw new TypeError(`unknown order "${id}"`);
    return order;
  });
  const vectors = orders.map((order) => shiftVectors(order, norm.shifts));
  const stationUsed = new Map([...norm.stations.keys()].map((id) => [id, new Array(norm.shifts).fill(0)]));
  const lineUsed = new Map([...norm.lines.keys()].map((id) => [id, new Array(norm.shifts).fill(0)]));
  const assignments = [];
  const chosen = new Array(orders.length);
  let truncated = false;

  const fits = (order, vector) => {
    for (let stepIndex = 0; stepIndex < order.route.length; stepIndex += 1) {
      const step = order.route[stepIndex];
      const shift = vector[stepIndex];
      const station = norm.stations.get(step.station);
      if (stationUsed.get(step.station)[shift] + step.minutes > station.capacity[shift]) return false;
      if (lineUsed.get(station.lineId)[shift] + step.minutes > norm.lines.get(station.lineId).budget[shift]) return false;
    }
    return true;
  };
  const apply = (order, vector, sign) => {
    for (let stepIndex = 0; stepIndex < order.route.length; stepIndex += 1) {
      const step = order.route[stepIndex];
      const shift = vector[stepIndex];
      const station = norm.stations.get(step.station);
      stationUsed.get(step.station)[shift] += sign * step.minutes;
      lineUsed.get(station.lineId)[shift] += sign * step.minutes;
    }
  };

  const walk = (index) => {
    if (truncated) return;
    if (index === orders.length) {
      assignments.push(chosen.map((vector) => [...vector]));
      if (assignments.length >= limit) truncated = true;
      return;
    }
    for (const vector of vectors[index]) {
      if (fits(orders[index], vector)) {
        apply(orders[index], vector, 1);
        chosen[index] = vector;
        walk(index + 1);
        apply(orders[index], vector, -1);
      }
    }
  };
  walk(0);

  return { orders: orderIds, assignments, truncated };
}

// Builds a canonical key for one order's timing, used to compare the
// scheduler output against enumerated assignments.
export function timingKey(steps) {
  return [...steps].sort((a, b) => a.stepIndex - b.stepIndex).map((step) => step.shift).join(',');
}
