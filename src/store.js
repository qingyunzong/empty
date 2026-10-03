// Persistent event store with idempotent ingest and versioned corrections.
//
// Store file layout:
// {
//   "version": <int>,            // bumped once per accepted (non-duplicate) event
//   "events": [ ... ],           // all accepted events, in arrival order
//   "corrections": [ ... ]       // versioned incremental corrections for late events
// }

import { existsSync, readFileSync, writeFileSync } from 'node:fs';

export function emptyStore() {
  return { version: 0, events: [], corrections: [] };
}

export function loadStore(path) {
  if (!existsSync(path)) return emptyStore();
  return JSON.parse(readFileSync(path, 'utf8'));
}

export function saveStore(path, store) {
  writeFileSync(path, `${JSON.stringify(store, null, 2)}\n`);
}

// Ingest already-validated events. Duplicates (same id) are dropped without
// any version bump. A late event (its ts is behind the newest ts already
// stored for the same device) is accepted but recorded as a versioned
// incremental correction instead of being rejected.
export function ingestEvents(store, events) {
  const seen = new Set(store.events.map((event) => event.id));
  const accepted = [];
  const duplicates = [];
  const corrections = [];
  for (const event of events) {
    if (seen.has(event.id)) {
      duplicates.push(event.id);
      continue;
    }
    seen.add(event.id);
    let maxTs = -Infinity;
    for (const existing of store.events) {
      if (existing.device === event.device && existing.ts > maxTs) maxTs = existing.ts;
    }
    store.events.push(event);
    store.version += 1;
    accepted.push(event.id);
    if (event.ts < maxTs) {
      const correction = {
        version: store.version,
        eventId: event.id,
        device: event.device,
        reason: 'late-event',
      };
      store.corrections.push(correction);
      corrections.push(correction);
    }
  }
  return { accepted, duplicates, corrections, version: store.version };
}

// Diff two store snapshots: events/corrections present in next but not in prev.
export function diffStores(prev, next) {
  const prevIds = new Set(prev.events.map((event) => event.id));
  const prevCorrections = new Set(prev.corrections.map((c) => `${c.version}:${c.eventId}`));
  return {
    versionFrom: prev.version,
    versionTo: next.version,
    addedEvents: next.events.filter((event) => !prevIds.has(event.id)),
    addedCorrections: next.corrections.filter(
      (c) => !prevCorrections.has(`${c.version}:${c.eventId}`),
    ),
  };
}
