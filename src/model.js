import { SimError, ERR_DOMAIN } from './errors.js';
import { mulberry32, generateArrivals } from './prng.js';

function domain(cond, msg) {
  if (!cond) throw new SimError(ERR_DOMAIN, msg);
}

// Validates and normalizes a user config into the internal form used by the
// simulator, certificate builder, minimizer and incremental engine.
export function normalizeConfig(config = {}) {
  const stations = (config.stations ?? []).map((s, i) => {
    const cap = s?.cap ?? 1;
    const proc = s?.proc ?? 1;
    domain(Number.isInteger(cap) && cap >= 0, `stations[${i}].cap must be a non-negative integer, got ${cap}`);
    domain(typeof proc === 'number' && Number.isFinite(proc) && proc >= 0, `stations[${i}].proc must be a non-negative finite number, got ${proc}`);
    return { cap, proc };
  });
  const buffers = (config.buffers ?? []).map((b, i) => {
    const cap = b?.cap ?? 0;
    domain(Number.isInteger(cap) && cap >= 0, `buffers[${i}].cap must be a non-negative integer, got ${cap}`);
    return { cap };
  });
  domain(
    buffers.length === stations.length + 1,
    `expected exactly stations.length + 1 (${stations.length + 1}) buffers, got ${buffers.length}`,
  );
  const policy = config.policy ?? 'fifo';
  domain(policy === 'fifo' || policy === 'priority', `unknown policy: ${policy}`);
  const arrivals = normalizeArrivals(config.arrivals);
  const customEvents = (config.customEvents ?? []).map((e, i) => {
    domain(typeof e?.time === 'number' && Number.isFinite(e.time) && e.time >= 0, `customEvents[${i}].time must be a non-negative finite number`);
    domain(typeof e?.apply === 'function', `customEvents[${i}].apply must be a function`);
    return { time: e.time, apply: e.apply };
  });
  const totalProc = stations.reduce((acc, s) => acc + s.proc, 0);
  const lastArrival = arrivals.length ? arrivals[arrivals.length - 1].time : 0;
  const lastCustom = customEvents.reduce((acc, e) => Math.max(acc, e.time), 0);
  const horizon = config.horizon ?? Math.max(lastArrival, lastCustom) + arrivals.length * totalProc + 1;
  domain(Number.isFinite(horizon) && horizon >= 0, `horizon must be a non-negative finite number, got ${horizon}`);
  const stateBudget = config.stateBudget ?? 100000;
  domain(Number.isInteger(stateBudget) && stateBudget > 0, `stateBudget must be a positive integer, got ${stateBudget}`);
  const cycleLimit = config.cycleLimit ?? 10000;
  domain(Number.isInteger(cycleLimit) && cycleLimit > 0, `cycleLimit must be a positive integer, got ${cycleLimit}`);
  return { stations, buffers, arrivals, policy, horizon, stateBudget, cycleLimit, customEvents };
}

function normalizeArrivals(spec) {
  if (!spec) return [];
  let list;
  if (Array.isArray(spec.times)) {
    domain(
      !spec.priorities || spec.priorities.length === spec.times.length,
      'arrivals.priorities must have the same length as arrivals.times',
    );
    const levels = spec.priorityLevels ?? 3;
    const rand = mulberry32(spec.seed ?? 0);
    list = spec.times.map((time, i) => ({
      id: i + 1,
      time,
      priority: spec.priorities ? spec.priorities[i] : Math.floor(rand() * levels),
    }));
  } else {
    list = generateArrivals(spec);
  }
  for (const a of list) {
    domain(Number.isFinite(a.time) && a.time >= 0, `arrival time must be a non-negative finite number, got ${a.time}`);
    domain(Number.isInteger(a.priority) && a.priority >= 0, `arrival priority must be a non-negative integer, got ${a.priority}`);
  }
  // Stable ordering: by time, ties broken by id (generation order).
  return list.slice().sort((x, y) => x.time - y.time || x.id - y.id);
}
