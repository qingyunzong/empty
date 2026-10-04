import { Store } from '../src/store.js';

export const UTC_ZONE = { 'Etc/UTC': [{ from: null, offsetMinutes: 0 }] };

export function weekdayWindowConfig(overrides = {}) {
  return {
    cmd: 'config',
    timezones: UTC_ZONE,
    window: {
      zone: 'Etc/UTC',
      weekly: [{ days: [1, 2, 3, 4, 5], start: '09:00', end: '17:00' }],
      holidays: [],
      ...overrides.window,
    },
    ...(overrides.defects ? { defects: overrides.defects } : {}),
  };
}

export function makeStore(configCmd = weekdayWindowConfig()) {
  const store = new Store();
  store.apply(configCmd);
  return store;
}

// Adds a received + available + passed-inspection batch. Inspection happens
// Monday 2026-06-01 10:00 UTC (inside the weekday window) unless overridden.
export function stockBatch(store, id, { qty, expiry, span = ['2026-01-01T00:00:00Z', '2026-01-10T00:00:00Z'], inspectedAt = '2026-06-01T10:00:00Z', inspect = true }) {
  store.apply({ cmd: 'receive', batch: id, qty, expiry, span, at: inspectedAt });
  store.apply({ cmd: 'available', batch: id, at: inspectedAt });
  if (inspect) store.apply({ cmd: 'inspect', batch: id, inspectedAt, passed: true });
}
