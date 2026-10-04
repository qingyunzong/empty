import { Simulation } from './simulator.js';

// Given a normalized config whose run overflows, computes a 1-minimal prefix
// of the arrival sequence (all arrivals up to the first overflow time) that
// still overflows: removing any single arrival from the returned set makes
// the overflow disappear. Delta-debugging style deletion loop.
export function minimizeOverflowPrefix(norm) {
  const first = new Simulation(norm).run().firstViolation;
  if (!first || first.type !== 'bufferOverflow') return null;
  const overflows = (ids) => {
    const keep = new Set(ids);
    const sub = { ...norm, arrivals: norm.arrivals.filter((a) => keep.has(a.id)) };
    return new Simulation(sub).run().firstViolation?.type === 'bufferOverflow';
  };
  let current = norm.arrivals.filter((a) => a.time <= first.time).map((a) => a.id);
  let changed = true;
  while (changed) {
    changed = false;
    for (const id of [...current]) {
      const trial = current.filter((x) => x !== id);
      if (trial.length > 0 && overflows(trial)) {
        current = trial;
        changed = true;
      }
    }
  }
  return { arrivals: current.slice().sort((a, b) => a - b), verifies: overflows(current) };
}
