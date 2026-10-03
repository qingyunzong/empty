import { readFileSync, writeFileSync, renameSync, existsSync } from 'node:fs';
import { dirname } from 'node:path';
import { validateEvents } from './schema.js';
import { summarizeAll } from './engine.js';

export const DEFAULT_STATE_PATH = process.env.DOWNTIME_STATE ?? './downtime-state.json';

function emptyStore() {
  return { version: 0, events: {}, corrections: [] };
}

export function loadStore(path = DEFAULT_STATE_PATH) {
  if (!existsSync(path)) return emptyStore();
  const parsed = JSON.parse(readFileSync(path, 'utf8'));
  return {
    version: parsed.version ?? 0,
    events: parsed.events ?? {},
    corrections: parsed.corrections ?? [],
  };
}

export function saveStore(store, path = DEFAULT_STATE_PATH) {
  const tmp = `${path}.tmp-${process.pid}`;
  writeFileSync(tmp, `${JSON.stringify(store, null, 2)}\n`, 'utf8');
  renameSync(tmp, path);
}

// Ingest a batch of events. Duplicate ids are idempotent (ignored). Any
// batch containing at least one new event bumps the version and records a
// versioned correction entry; late events (ts below the device's current
// maximum) are flagged but never rejected.
export function ingestEvents(store, events) {
  validateEvents(events);
  const added = [];
  const duplicates = [];
  const late = [];
  const maxTsByDevice = new Map();
  for (const stored of Object.values(store.events)) {
    maxTsByDevice.set(stored.device, Math.max(maxTsByDevice.get(stored.device) ?? -Infinity, stored.ts));
  }
  for (const event of events) {
    if (store.events[event.id] !== undefined) {
      duplicates.push(event.id);
      continue;
    }
    const nextVersion = store.version + 1;
    store.events[event.id] = { ...event, ingestedAt: nextVersion };
    added.push(event.id);
    if (event.ts < (maxTsByDevice.get(event.device) ?? -Infinity)) late.push(event.id);
    maxTsByDevice.set(event.device, Math.max(maxTsByDevice.get(event.device) ?? -Infinity, event.ts));
  }
  if (added.length > 0) {
    store.version += 1;
    store.corrections.push({
      version: store.version,
      added,
      duplicates,
      late,
      recordedAt: new Date().toISOString(),
    });
  }
  return { version: store.version, added, duplicates, late };
}

export function eventsAtVersion(store, version) {
  return Object.values(store.events).filter((e) => e.ingestedAt <= version);
}

export function queryStore(store, { watermark = null, device = null } = {}) {
  const events = Object.values(store.events);
  const devices = summarizeAll(events, { watermark });
  const selected = device === null ? devices : (devices[device] ? { [device]: devices[device] } : {});
  return {
    version: store.version,
    watermark,
    eventCount: events.length,
    devices: selected,
  };
}

// Diff two versions of the store: the versioned corrections recorded between
// them plus the per-device changes in the computed summaries.
export function diffStore(store, { from = null, to = null, watermark = null } = {}) {
  const toVersion = to ?? store.version;
  const fromVersion = from ?? Math.max(0, toVersion - 1);
  if (fromVersion > toVersion) {
    throw new Error(`invalid version range: from ${fromVersion} > to ${toVersion}`);
  }
  const before = summarizeAll(eventsAtVersion(store, fromVersion), { watermark });
  const after = summarizeAll(eventsAtVersion(store, toVersion), { watermark });
  const changes = {};
  const deviceNames = new Set([...Object.keys(before), ...Object.keys(after)]);
  for (const name of deviceNames) {
    const b = before[name] ?? null;
    const a = after[name] ?? null;
    const delta = {};
    if (b === null) {
      delta.appeared = { from: null, to: a.status };
    } else if (a === null) {
      delta.disappeared = { from: b.status, to: null };
    } else {
      for (const field of ['status', 'downtimeMs', 'availability', 'minDowntimeMs', 'maxDowntimeMs', 'eventCount']) {
        const bv = b[field] ?? null;
        const av = a[field] ?? null;
        if (JSON.stringify(bv) !== JSON.stringify(av)) delta[field] = { from: bv, to: av };
      }
      if (JSON.stringify(b.intervals) !== JSON.stringify(a.intervals)) {
        delta.intervals = { from: b.intervals, to: a.intervals };
      }
    }
    if (Object.keys(delta).length > 0) changes[name] = delta;
  }
  return {
    from: fromVersion,
    to: toVersion,
    watermark,
    corrections: store.corrections.filter((c) => c.version > fromVersion && c.version <= toVersion),
    changes,
  };
}
