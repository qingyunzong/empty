import { Scheduler } from './scheduler.js';

/**
 * Replay an event log and check the scheduling invariants:
 *  - station capacity is never overdrawn and never over-released;
 *  - line labor budget is never overdrawn and never over-released;
 *  - atomicity: at every shift boundary each order holds either no levels
 *    or its complete route (no half-allocated locks survive);
 *  - releases only ever undo previously consumed levels.
 */
export function verifyEvents(config, events, orders = []) {
  const violations = [];
  const stations = new Map((config.stations ?? []).map((s) => [s.id, s]));
  const lines = new Map((config.lines ?? []).map((l) => [l.id, l]));
  const routeLengths = new Map(
    orders
      .filter((o) => o && typeof o.id === 'string' && Array.isArray(o.route))
      .map((o) => [o.id, o.route.length]),
  );
  const capacityAt = (station, shift) =>
    station.calendar ? (station.calendar[shift]?.capacity ?? 0) : station.capacityPerShift;

  let shift = -1;
  const remainingCapacity = new Map();
  const remainingBudget = new Map();
  const held = new Map(); // orderId -> Map(level -> minutes)

  const checkAtomicity = (atShift) => {
    for (const [orderId, levels] of held) {
      const routeLength = routeLengths.get(orderId);
      if (routeLength === undefined) continue;
      if (levels.size !== 0 && levels.size !== routeLength) {
        violations.push(
          `shift ${atShift}: order ${orderId} holds ${levels.size}/${routeLength} levels (partial lock survived)`,
        );
      }
    }
  };

  for (const event of events) {
    if (event.shift !== shift) {
      if (shift !== -1) checkAtomicity(shift);
      shift = event.shift;
      for (const [id, station] of stations) remainingCapacity.set(id, capacityAt(station, shift));
      for (const [id, line] of lines) remainingBudget.set(id, line.budgetPerShift);
    }
    const apply = (sign) => {
      const station = stations.get(event.station);
      const line = lines.get(event.lineId);
      if (!station || !line) {
        violations.push(`shift ${shift}: event references unknown station/line`);
        return;
      }
      const capacity = remainingCapacity.get(event.station) + sign * event.minutes;
      const budget = remainingBudget.get(event.lineId) + sign * event.minutes;
      if (capacity < 0) {
        violations.push(`shift ${shift}: station ${event.station} capacity overdrawn to ${capacity}`);
      }
      if (capacity > capacityAt(station, shift)) {
        violations.push(`shift ${shift}: station ${event.station} capacity over-released to ${capacity}`);
      }
      if (budget < 0) {
        violations.push(`shift ${shift}: line ${event.lineId} budget overdrawn to ${budget}`);
      }
      if (budget > line.budgetPerShift) {
        violations.push(`shift ${shift}: line ${event.lineId} budget over-released to ${budget}`);
      }
      remainingCapacity.set(event.station, capacity);
      remainingBudget.set(event.lineId, budget);
    };
    if (event.type === 'consume') {
      apply(-1);
      if (!held.has(event.orderId)) held.set(event.orderId, new Map());
      held.get(event.orderId).set(event.level, event.minutes);
    } else if (event.type === 'release') {
      apply(+1);
      const levels = held.get(event.orderId);
      if (!levels || !levels.has(event.level)) {
        violations.push(`shift ${shift}: order ${event.orderId} released level ${event.level} it never held`);
      } else {
        levels.delete(event.level);
      }
    } else {
      violations.push(`shift ${shift}: unknown event type ${event.type}`);
    }
  }
  if (shift !== -1) checkAtomicity(shift);
  return { ok: violations.length === 0, violations };
}

function* permutations(items) {
  if (items.length <= 1) {
    yield items.slice();
    return;
  }
  for (let i = 0; i < items.length; i++) {
    const rest = items.slice(0, i).concat(items.slice(i + 1));
    for (const perm of permutations(rest)) {
      yield [items[i], ...perm];
    }
  }
}

/**
 * Exhaustive route-timing verification: for at most 4 work orders, replay
 * every submission order (arrival timing permutation) on a fresh scheduler
 * and verify the invariants of each resulting event log.
 */
export function enumerateTimings(config, orders) {
  if (!Array.isArray(orders) || orders.length === 0 || orders.length > 4) {
    throw new RangeError('enumeration requires between 1 and 4 work orders');
  }
  const violations = [];
  let permutationsChecked = 0;
  for (const perm of permutations(orders)) {
    const scheduler = new Scheduler(config);
    for (const order of perm) scheduler.addOrder(structuredClone(order));
    scheduler.run();
    const result = scheduler.getResult();
    const verification = verifyEvents(config, result.events, orders);
    for (const message of verification.violations) {
      violations.push(`permutation [${perm.map((o) => o.id).join(', ')}]: ${message}`);
    }
    permutationsChecked += 1;
  }
  return { ok: violations.length === 0, permutationsChecked, violations };
}
