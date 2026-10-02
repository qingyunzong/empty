import { mulberry32 } from '../src/inject.js';

export const TYPES = ['run', 'idle', 'fault', 'changeover', 'maintenance'];

export function randomEvents(seed, maxN = 14) {
  const rng = mulberry32(seed >>> 0);
  const n = Math.floor(rng() * (maxN + 1));
  const events = [];
  for (let i = 0; i < n; i++) {
    const start = Math.floor(rng() * 1000);
    const duration = 1 + Math.floor(rng() * 200);
    events.push({
      id: `e${i}`,
      type: TYPES[Math.floor(rng() * TYPES.length)],
      start,
      end: start + duration,
    });
  }
  return events;
}
