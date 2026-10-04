// Event validation. Every violation raises InputError (CLI: exit code 2).
import { InputError } from './model.js';

const isNonNegInt = (v) => Number.isInteger(v) && v >= 0;
const isPosInt = (v) => Number.isInteger(v) && v >= 1;
const isConf = (v) => typeof v === 'number' && Number.isFinite(v) && v >= 0 && v <= 1;
const isName = (v) => typeof v === 'string' && v.length > 0 && !v.includes('\u0001');

export function validateEvent(raw, state, isFirst) {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new InputError('event must be a JSON object');
  }
  switch (raw.type) {
    case 'config': {
      if (!isFirst) throw new InputError('config must be the first event');
      const { coordBins, magBins, capacity } = raw;
      if (!isPosInt(coordBins) || coordBins > 4096) throw new InputError('config.coordBins must be an integer in [1,4096]');
      if (!isPosInt(magBins) || magBins > 4096) throw new InputError('config.magBins must be an integer in [1,4096]');
      if (!isNonNegInt(capacity)) throw new InputError('config.capacity must be a non-negative integer');
      return { type: 'config', config: { coordBins, magBins, capacity } };
    }
    case 'add_obs': {
      const { id, star, night, ts, coord, mag, conf } = raw;
      if (!isName(id)) throw new InputError('add_obs.id must be a non-empty string without control characters');
      if (state.obs[id]) throw new InputError(`duplicate observation id '${id}' (unique primary key)`);
      if (!isName(star)) throw new InputError('add_obs.star must be a non-empty string without control characters');
      if (!isNonNegInt(night)) throw new InputError('add_obs.night must be a non-negative integer');
      if (!isNonNegInt(ts)) throw new InputError('add_obs.ts must be a non-negative integer');
      if (!Number.isInteger(coord) || coord < 0 || coord >= state.config.coordBins) {
        throw new InputError(`add_obs.coord out of range [0, ${state.config.coordBins})`);
      }
      if (!Number.isInteger(mag) || mag < 0 || mag >= state.config.magBins) {
        throw new InputError(`add_obs.mag out of range [0, ${state.config.magBins})`);
      }
      if (!isConf(conf)) throw new InputError('add_obs.conf must be a number in [0, 1]');
      return { type: 'add_obs', obs: { id, star, night, ts, coord, mag, conf, active: true, events: [] } };
    }
    case 'retract_obs': {
      const obs = isName(raw.id) ? state.obs[raw.id] : undefined;
      if (!obs) throw new InputError(`retract_obs: unknown observation '${raw.id}'`);
      if (!obs.active) throw new InputError(`retract_obs: observation '${raw.id}' is already retracted`);
      return { type: 'retract_obs', id: raw.id };
    }
    case 'correct_obs': {
      const obs = isName(raw.id) ? state.obs[raw.id] : undefined;
      if (!obs) throw new InputError(`correct_obs: unknown observation '${raw.id}'`);
      if (!obs.active) throw new InputError(`correct_obs: observation '${raw.id}' was retracted`);
      if ('star' in raw || 'night' in raw || 'id' in raw && raw.id !== obs.id) {
        throw new InputError('correct_obs: id, star and night are immutable');
      }
      const patch = {};
      if ('coord' in raw) {
        if (!Number.isInteger(raw.coord) || raw.coord < 0 || raw.coord >= state.config.coordBins) {
          throw new InputError(`correct_obs.coord out of range [0, ${state.config.coordBins})`);
        }
        patch.coord = raw.coord;
      }
      if ('mag' in raw) {
        if (!Number.isInteger(raw.mag) || raw.mag < 0 || raw.mag >= state.config.magBins) {
          throw new InputError(`correct_obs.mag out of range [0, ${state.config.magBins})`);
        }
        patch.mag = raw.mag;
      }
      if ('conf' in raw) {
        if (!isConf(raw.conf)) throw new InputError('correct_obs.conf must be a number in [0, 1]');
        patch.conf = raw.conf;
      }
      if ('ts' in raw) {
        if (!isNonNegInt(raw.ts)) throw new InputError('correct_obs.ts must be a non-negative integer');
        patch.ts = raw.ts;
      }
      if (Object.keys(patch).length === 0) {
        throw new InputError('correct_obs: no correctable fields given (allowed: coord, mag, conf, ts)');
      }
      return { type: 'correct_obs', id: raw.id, patch };
    }
    case 'checkpoint': {
      if (!isName(raw.name)) throw new InputError('checkpoint.name must be a non-empty string');
      return { type: 'checkpoint', name: raw.name };
    }
    case 'undo_to': {
      if (!isName(raw.name)) throw new InputError('undo_to.name must be a non-empty string');
      return { type: 'undo_to', name: raw.name };
    }
    case 'solve': {
      if (raw.budget === undefined) return { type: 'solve', budget: null };
      const b = raw.budget;
      if (b === null || typeof b !== 'object' || Array.isArray(b)) {
        throw new InputError('solve.budget must be an object {propagation?, backtrack?}');
      }
      const budget = {};
      if ('propagation' in b) {
        if (!isNonNegInt(b.propagation)) throw new InputError('solve.budget.propagation must be a non-negative integer');
        budget.propagation = b.propagation;
      }
      if ('backtrack' in b) {
        if (!isNonNegInt(b.backtrack)) throw new InputError('solve.budget.backtrack must be a non-negative integer');
        budget.backtrack = b.backtrack;
      }
      return { type: 'solve', budget };
    }
    default:
      throw new InputError(`unknown event type: ${JSON.stringify(raw.type)}`);
  }
}
