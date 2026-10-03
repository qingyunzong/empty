import { ExitError } from './errors.js';

// Builds the factory -> workshop -> kettle hierarchy and ancestry helpers.
export function buildPlant(raw) {
  const factories = raw?.factories ?? [];
  const factoryIds = new Set();
  const workshopIds = new Set();
  const kettleIds = new Set();
  const workshopToFactory = new Map();
  const kettleToWorkshop = new Map();

  for (const f of factories) {
    if (!f || typeof f.id !== 'string') throw new ExitError(2, 'factory missing id');
    if (factoryIds.has(f.id)) throw new ExitError(2, `duplicate factory ${f.id}`);
    factoryIds.add(f.id);
    for (const w of f.workshops ?? []) {
      if (!w || typeof w.id !== 'string') throw new ExitError(2, 'workshop missing id');
      if (workshopIds.has(w.id)) throw new ExitError(2, `duplicate workshop ${w.id}`);
      workshopIds.add(w.id);
      workshopToFactory.set(w.id, f.id);
      for (const k of w.kettles ?? []) {
        if (typeof k !== 'string') throw new ExitError(2, 'kettle id must be a string');
        if (kettleIds.has(k)) throw new ExitError(2, `duplicate kettle ${k}`);
        kettleIds.add(k);
        kettleToWorkshop.set(k, w.id);
      }
    }
  }

  return {
    factoryIds,
    workshopIds,
    kettleIds,
    has(level, id) {
      if (level === 'factory') return factoryIds.has(id);
      if (level === 'workshop') return workshopIds.has(id);
      if (level === 'kettle') return kettleIds.has(id);
      return false;
    },
    workshopOf(kettleId) {
      return kettleToWorkshop.get(kettleId);
    },
    factoryOf(workshopId) {
      return workshopToFactory.get(workshopId);
    },
    // Decision chain ordered nearest-first: kettle, workshop, factory.
    chainOf(kettleId) {
      const chain = [{ level: 'kettle', id: kettleId }];
      const w = kettleToWorkshop.get(kettleId);
      if (w !== undefined) {
        chain.push({ level: 'workshop', id: w });
        const f = workshopToFactory.get(w);
        if (f !== undefined) chain.push({ level: 'factory', id: f });
      }
      return chain;
    },
  };
}
