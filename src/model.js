// Core data model for the observatory night catalog.
// State is a plain JSON-able object so checkpoints can snapshot it with
// structuredClone and tests can deep-compare states directly.

export class InputError extends Error {
  constructor(message, code = 'INVALID_INPUT') {
    super(message);
    this.name = 'InputError';
    this.code = code;
  }
}

export const DEFAULT_CONFIG = Object.freeze({ coordBins: 8, magBins: 4, capacity: 8 });

export function cellId(config, coord, mag) {
  return coord * config.magBins + mag;
}

export function cellCoord(config, cell) {
  return Math.floor(cell / config.magBins);
}

export function cellMag(config, cell) {
  return cell % config.magBins;
}

export function nightStarKey(night, star) {
  return `${night}\u0001${star}`;
}

export function createState(config = DEFAULT_CONFIG) {
  return {
    config: { coordBins: config.coordBins, magBins: config.magBins, capacity: config.capacity },
    obs: {},      // id -> {id, star, night, ts, coord, mag, conf, active, events:[eventIndex...]}
    order: [],    // observation ids in event-application order (time_order reference)
    domains: {},  // "night<US>star" -> { cellId: [obsId...] }  (active contributions only)
  };
}

export function applyAdd(state, obs) {
  state.obs[obs.id] = obs;
  state.order.push(obs.id);
  const key = nightStarKey(obs.night, obs.star);
  const cell = cellId(state.config, obs.coord, obs.mag);
  const dom = (state.domains[key] ??= {});
  (dom[cell] ??= []).push(obs.id);
}

function removeContribution(state, key, cell, id) {
  const dom = state.domains[key];
  if (!dom || !dom[cell]) return;
  const next = dom[cell].filter((x) => x !== id);
  if (next.length === 0) delete dom[cell];
  else dom[cell] = next;
  if (Object.keys(dom).length === 0) delete state.domains[key];
}

export function applyRetract(state, id) {
  const obs = state.obs[id];
  if (!obs || !obs.active) return;
  obs.active = false;
  removeContribution(state, nightStarKey(obs.night, obs.star), cellId(state.config, obs.coord, obs.mag), id);
}

// Incremental correction: only the touched (night, star) domain entry is
// updated; every other star/night is left untouched (no full recompute).
export function applyCorrect(state, id, patch) {
  const obs = state.obs[id];
  const before = cellId(state.config, obs.coord, obs.mag);
  if (patch.coord !== undefined) obs.coord = patch.coord;
  if (patch.mag !== undefined) obs.mag = patch.mag;
  if (patch.conf !== undefined) obs.conf = patch.conf;
  if (patch.ts !== undefined) obs.ts = patch.ts;
  const after = cellId(state.config, obs.coord, obs.mag);
  if (after !== before) {
    const key = nightStarKey(obs.night, obs.star);
    removeContribution(state, key, before, id);
    const dom = (state.domains[key] ??= {});
    (dom[after] ??= []).push(id);
  }
}
