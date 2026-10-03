// Incrementally maintained star catalog over a JSONL event stream.
//
// Events: add_obs, retract_obs, correct_obs, checkpoint, undo_to, solve.
//
// Incrementality: star domains are maintained as observations come and go.
// add_obs narrows one star's domains by intersection; retract_obs /
// correct_obs recompute only the affected stars (never the whole catalog).
// correct_obs additionally reports the alldiff cascade it triggers, so a
// correction's chained reassignment is observable without a full re-solve.
//
// Checkpoints form a stack. undo_to(name) restores the innermost checkpoint
// and only if `name` matches it: skipping levels (越级回滚) is rejected and a
// failed undo leaves the state untouched, i.e. at the most recent consistent
// point. Restoring truncates the effective event log, so continuing after an
// undo is identical to replaying the surviving prefix from scratch.

import {
  solveObservations,
  propagate,
  cloneDomains,
  Conflict,
  CONSTRAINT_ATTRIBUTION_CONSISTENCY,
  CONSTRAINT_EXCLUSIVE_ATTRIBUTION,
  CONSTRAINT_UNIQUE_PK,
} from './solver.js';

export class CatalogError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'CatalogError';
    this.code = code;
  }
}

export const DEFAULT_LIMITS = Object.freeze({ coords: 8, mags: 6, creds: 4, capacity: 4 });

const VALUE_FIELDS = ['coord', 'mag', 'cred'];
const FIELD_LIMIT = { coord: 'coords', mag: 'mags', cred: 'creds' };

const fullDomain = (n) => new Set(Array.from({ length: n }, (_, i) => i));
const sortedValues = (set) => [...set].sort((a, b) => a - b);

function needString(value, name) {
  if (typeof value !== 'string' || value.length === 0) {
    throw new CatalogError('INVALID_EVENT', `field '${name}' must be a non-empty string`);
  }
  return value;
}

// A bin field accepts a single bin index or a non-empty array of candidate
// bins; it is normalized to a sorted, de-duplicated array.
function needBinSet(value, name, limit) {
  const raw = Array.isArray(value) ? value : [value];
  const bins = [...new Set(raw.map((v) => needInt(v, name, 0, limit)))].sort((a, b) => a - b);
  if (bins.length === 0) {
    throw new CatalogError('INVALID_EVENT', `field '${name}' must be a bin index or a non-empty array of bins`);
  }
  return bins;
}

function needInt(value, name, min, maxExclusive) {
  if (!Number.isInteger(value) || value < min || (maxExclusive !== undefined && value >= maxExclusive)) {
    const hi = maxExclusive === undefined ? 'inf' : String(maxExclusive);
    throw new CatalogError('INVALID_EVENT', `field '${name}' must be an integer in [${min}, ${hi})`);
  }
  return value;
}

export class Catalog {
  constructor(limits = {}) {
    this.limits = { ...DEFAULT_LIMITS, ...limits };
    for (const key of ['coords', 'mags', 'creds', 'capacity']) {
      if (!Number.isInteger(this.limits[key]) || this.limits[key] < 1) {
        throw new CatalogError('INVALID_LIMITS', `limit '${key}' must be a positive integer`);
      }
    }
    this.obsById = new Map(); // id -> [obs, ...] (LIFO; length > 1 violates unique_pk)
    this.starObs = new Map(); // star -> Set(obs)
    this.starDomains = new Map(); // star -> { coord:Set, mag:Set, cred:Set }
    this.nightCount = new Map(); // night -> active observation count
    this.eventLog = []; // effective state-changing events (add/retract/correct)
    this.checkpoints = []; // stack of { name, snapshot }
  }

  activeObs() {
    return [...this.obsById.values()].flat();
  }

  _ensureStar(star) {
    if (!this.starObs.has(star)) {
      this.starObs.set(star, new Set());
      this.starDomains.set(star, {
        coord: fullDomain(this.limits.coords),
        mag: fullDomain(this.limits.mags),
        cred: fullDomain(this.limits.creds),
      });
    }
  }

  _intersect(star, obs) {
    const domains = this.starDomains.get(star);
    for (const field of VALUE_FIELDS) {
      const domain = domains[field];
      for (const value of [...domain]) {
        if (!obs[field].includes(value)) domain.delete(value);
      }
    }
  }

  // Star-local recomputation after a removal or correction. Touches only this
  // star; the rest of the catalog is left alone.
  _recomputeStar(star) {
    const set = this.starObs.get(star);
    if (!set || set.size === 0) {
      this.starObs.delete(star);
      this.starDomains.delete(star);
      return;
    }
    const domains = {
      coord: fullDomain(this.limits.coords),
      mag: fullDomain(this.limits.mags),
      cred: fullDomain(this.limits.creds),
    };
    for (const obs of set) {
      for (const field of VALUE_FIELDS) {
        const domain = domains[field];
        for (const value of [...domain]) {
          if (!obs[field].includes(value)) domain.delete(value);
        }
      }
    }
    this.starDomains.set(star, domains);
  }

  _serializeStarDomains(stars) {
    const out = {};
    for (const star of stars) {
      const d = this.starDomains.get(star);
      if (d) {
        out[star] = {
          coord: sortedValues(d.coord),
          mag: sortedValues(d.mag),
          cred: sortedValues(d.cred),
        };
      }
    }
    return out;
  }

  static _diffDomains(before, after) {
    const changes = [];
    const names = new Set([...Object.keys(before), ...Object.keys(after)]);
    for (const star of [...names].sort()) {
      for (const field of VALUE_FIELDS) {
        const b = before[star]?.[field] ?? null;
        const a = after[star]?.[field] ?? null;
        if (JSON.stringify(b) !== JSON.stringify(a)) {
          changes.push({ star, field, from: b, to: a });
        }
      }
    }
    return changes;
  }

  // Explain the incremental effects of a mutation: per-star domain changes,
  // the alldiff cascade they trigger (computed on a scratch copy), and any
  // conflicts with a human-readable explanation.
  _effects(affectedStars, before) {
    const after = this._serializeStarDomains(affectedStars);
    const changes = Catalog._diffDomains(before, after);
    const conflicts = [];
    for (const [star, d] of this.starDomains) {
      for (const field of VALUE_FIELDS) {
        if (d[field].size === 0) {
          conflicts.push({
            constraint: CONSTRAINT_ATTRIBUTION_CONSISTENCY,
            star,
            field,
            message: `star '${star}' has an empty ${field} domain: its observations disagree`,
            obs: [...this.starObs.get(star)].map((o) => o.id),
          });
        }
      }
    }
    let cascade = [];
    try {
      cascade = propagate(cloneDomains(this.starDomains), () => {});
    } catch (error) {
      if (error instanceof Conflict) {
        conflicts.push({ constraint: error.constraint, message: error.message });
      } else {
        throw error;
      }
    }
    return { changes, cascade, conflicts };
  }

  addObs(event) {
    const id = needString(event.id, 'id');
    const star = needString(event.star, 'star');
    const night = needInt(event.night, 'night', 0);
    const coord = needBinSet(event.coord, 'coord', this.limits.coords);
    const mag = needBinSet(event.mag, 'mag', this.limits.mags);
    const cred = needBinSet(event.cred, 'cred', this.limits.creds);

    const before = this._serializeStarDomains([star]);
    const obs = { id, star, night, coord, mag, cred, origin: this.eventLog.length, touches: [] };
    const list = this.obsById.get(id) ?? [];
    const duplicate = list.length > 0;
    list.push(obs);
    this.obsById.set(id, list);
    this._ensureStar(star);
    this.starObs.get(star).add(obs);
    this._intersect(star, obs);
    this.nightCount.set(night, (this.nightCount.get(night) ?? 0) + 1);
    this.eventLog.push({ type: 'add_obs', id, star, night, coord, mag, cred });

    const effects = this._effects([star], before);
    if (duplicate) {
      effects.conflicts.push({
        constraint: CONSTRAINT_UNIQUE_PK,
        message: `duplicate observation id '${id}'`,
        obs: [id],
      });
    }
    return { logIndex: this.eventLog.length - 1, effects };
  }

  retractObs(event) {
    const id = needString(event.id, 'id');
    const list = this.obsById.get(id);
    if (!list || list.length === 0) {
      throw new CatalogError('UNKNOWN_ID', `retract_obs: unknown observation id '${id}'`);
    }
    const obs = list[list.length - 1];
    const star = obs.star;
    const before = this._serializeStarDomains([star]);
    list.pop();
    if (list.length === 0) this.obsById.delete(id);
    this.starObs.get(star)?.delete(obs);
    this._recomputeStar(star);
    this.nightCount.set(obs.night, this.nightCount.get(obs.night) - 1);
    this.eventLog.push({ type: 'retract_obs', id });
    return { logIndex: this.eventLog.length - 1, effects: this._effects([star], before) };
  }

  correctObs(event) {
    const id = needString(event.id, 'id');
    const list = this.obsById.get(id);
    if (!list || list.length === 0) {
      throw new CatalogError('UNKNOWN_ID', `correct_obs: unknown observation id '${id}'`);
    }
    const provided = {};
    if (event.star !== undefined) provided.star = needString(event.star, 'star');
    if (event.night !== undefined) provided.night = needInt(event.night, 'night', 0);
    for (const field of VALUE_FIELDS) {
      if (event[field] !== undefined) {
        provided[field] = needBinSet(event[field], field, this.limits[FIELD_LIMIT[field]]);
      }
    }
    if (Object.keys(provided).length === 0) {
      throw new CatalogError('INVALID_EVENT', 'correct_obs must change at least one of star/night/coord/mag/cred');
    }

    const obs = list[list.length - 1];
    const oldStar = obs.star;
    const affected = new Set([oldStar]);
    if (provided.star !== undefined) affected.add(provided.star);
    const before = this._serializeStarDomains(affected);

    if (provided.night !== undefined && provided.night !== obs.night) {
      this.nightCount.set(obs.night, this.nightCount.get(obs.night) - 1);
      this.nightCount.set(provided.night, (this.nightCount.get(provided.night) ?? 0) + 1);
      obs.night = provided.night;
    }
    if (provided.star !== undefined && provided.star !== obs.star) {
      this.starObs.get(oldStar).delete(obs);
      obs.star = provided.star;
      this._ensureStar(provided.star);
      this.starObs.get(provided.star).add(obs);
    }
    for (const field of VALUE_FIELDS) {
      if (provided[field] !== undefined) obs[field] = provided[field];
    }
    // Incremental, star-local re-derivation of the touched stars only.
    this._recomputeStar(oldStar);
    this._recomputeStar(obs.star);

    obs.touches.push(this.eventLog.length);
    this.eventLog.push({ type: 'correct_obs', id, ...provided });
    return { logIndex: this.eventLog.length - 1, effects: this._effects(affected, before) };
  }

  _snapshot() {
    return structuredClone({
      obsById: this.obsById,
      starObs: this.starObs,
      starDomains: this.starDomains,
      nightCount: this.nightCount,
      eventLog: this.eventLog,
    });
  }

  _restore(snapshot) {
    this.obsById = snapshot.obsById;
    this.starObs = snapshot.starObs;
    this.starDomains = snapshot.starDomains;
    this.nightCount = snapshot.nightCount;
    this.eventLog = snapshot.eventLog;
  }

  checkpoint(name) {
    this.checkpoints.push({ name, snapshot: this._snapshot() });
  }

  undoTo(name) {
    if (this.checkpoints.length === 0) {
      throw new CatalogError('UNDO_EMPTY', 'undo_to: the checkpoint stack is empty');
    }
    const top = this.checkpoints[this.checkpoints.length - 1];
    if (top.name !== name) {
      const deeper = this.checkpoints.some((c, i) => i < this.checkpoints.length - 1 && c.name === name);
      if (deeper) {
        throw new CatalogError(
          'UNDO_SKIP_FORBIDDEN',
          `undo_to '${name}': skipping checkpoint levels is forbidden; the innermost checkpoint is '${top.name}'`,
        );
      }
      throw new CatalogError('UNDO_UNKNOWN_CHECKPOINT', `undo_to: no checkpoint named '${name}' on the stack`);
    }
    this.checkpoints.pop();
    this._restore(top.snapshot);
  }

  solve(budgets = {}) {
    const result = solveObservations(this.activeObs(), this.limits, budgets);
    if (result.status === 'UNSAT') {
      const eventIndices = new Set();
      const obsIds = new Set();
      for (const obs of result.coreObs) {
        obsIds.add(obs.id);
        eventIndices.add(obs.origin);
        for (const touch of obs.touches) eventIndices.add(touch);
      }
      result.core = {
        events: [...eventIndices].sort((a, b) => a - b),
        obs: [...obsIds].sort(),
        constraints: result.constraints,
      };
    }
    return result;
  }

  applyEvent(event) {
    if (event === null || typeof event !== 'object' || Array.isArray(event)) {
      throw new CatalogError('INVALID_EVENT', 'event must be a JSON object');
    }
    switch (event.type) {
      case 'add_obs': {
        const { logIndex, effects } = this.addObs(event);
        return { type: 'ack', event: 'add_obs', ok: true, log_index: logIndex, effects };
      }
      case 'retract_obs': {
        const { logIndex, effects } = this.retractObs(event);
        return { type: 'ack', event: 'retract_obs', ok: true, log_index: logIndex, effects };
      }
      case 'correct_obs': {
        const { logIndex, effects } = this.correctObs(event);
        return { type: 'ack', event: 'correct_obs', ok: true, log_index: logIndex, effects };
      }
      case 'checkpoint': {
        const name = needString(event.name, 'name');
        this.checkpoint(name);
        return { type: 'ack', event: 'checkpoint', ok: true, name, depth: this.checkpoints.length };
      }
      case 'undo_to': {
        const name = needString(event.name, 'name');
        this.undoTo(name);
        return { type: 'ack', event: 'undo_to', ok: true, name, depth: this.checkpoints.length };
      }
      case 'solve': {
        const budgets = {};
        if (event.prop_budget !== undefined) budgets.propagation = needInt(event.prop_budget, 'prop_budget', 0);
        if (event.back_budget !== undefined) budgets.backtracking = needInt(event.back_budget, 'back_budget', 0);
        const result = this.solve(budgets);
        return { type: 'solve_result', ...result };
      }
      case undefined:
        throw new CatalogError('INVALID_EVENT', "missing required field 'type'");
      default:
        throw new CatalogError('UNKNOWN_TYPE', `unknown event type '${event.type}'`);
    }
  }

  // Rebuild a catalog by replaying an effective event log from scratch.
  static replay(log, limits = {}) {
    const catalog = new Catalog(limits);
    for (const entry of log) catalog.applyEvent(entry);
    return catalog;
  }
}
