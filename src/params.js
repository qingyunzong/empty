import { schemaError } from './errors.js';

export const TYPES = Object.freeze(['run', 'idle', 'fault', 'changeover', 'maintenance']);

export const DEFAULT_PARAMS = Object.freeze({
  maxSkewMs: 5 * 60 * 1000,
  microStopThresholdMs: 60 * 1000,
  changeoverPlannedThresholdMs: 30 * 60 * 1000,
  priorities: Object.freeze({ fault: 40, maintenance: 30, changeover: 20, idle: 10, run: 0 }),
  uncovered: 'excluded',
  performance: 1,
  quality: 1,
});

export function resolveParams(overrides = {}) {
  if (overrides === null || typeof overrides !== 'object' || Array.isArray(overrides)) {
    throw schemaError('params must be an object');
  }
  const merged = {
    ...DEFAULT_PARAMS,
    ...overrides,
    priorities: { ...DEFAULT_PARAMS.priorities, ...(overrides.priorities ?? {}) },
  };
  for (const key of ['maxSkewMs', 'microStopThresholdMs', 'changeoverPlannedThresholdMs']) {
    if (!Number.isSafeInteger(merged[key]) || merged[key] < 0) {
      throw schemaError(`params.${key} must be a non-negative safe integer`, { value: merged[key] });
    }
  }
  for (const [type, priority] of Object.entries(merged.priorities)) {
    if (!TYPES.includes(type)) throw schemaError(`unknown event type in priorities: ${type}`);
    if (!Number.isSafeInteger(priority)) throw schemaError(`priority for "${type}" must be an integer`);
  }
  if (!['excluded', 'unplanned'].includes(merged.uncovered)) {
    throw schemaError('params.uncovered must be "excluded" or "unplanned"', { value: merged.uncovered });
  }
  for (const key of ['performance', 'quality']) {
    if (typeof merged[key] !== 'number' || Number.isNaN(merged[key]) || merged[key] < 0) {
      throw schemaError(`params.${key} must be a non-negative number`, { value: merged[key] });
    }
  }
  return merged;
}
