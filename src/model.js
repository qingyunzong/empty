// Domain primitives: locations, distances, moves.

export function parseLoc(input) {
  if (input && typeof input === 'object') {
    const { aisle, slot } = input;
    if (typeof aisle !== 'string' || !Number.isFinite(slot)) {
      throw new Error(`invalid location: ${JSON.stringify(input)}`);
    }
    return { aisle, slot };
  }
  if (typeof input === 'string') {
    const m = /^(.+):(-?\d+)$/.exec(input);
    if (!m) throw new Error(`invalid location: ${JSON.stringify(input)}`);
    return { aisle: m[1], slot: Number(m[2]) };
  }
  throw new Error(`invalid location: ${JSON.stringify(input)}`);
}

export function locKey(loc) {
  return `${loc.aisle}:${loc.slot}`;
}

export function aisleIndex(aisle) {
  const m = /(\d+)/.exec(aisle);
  return m ? Number(m[1]) : 0;
}

// Deterministic travel distance between two slots.
// Same aisle: slot distance. Cross aisle: out to the hub, across, back in.
export function distance(a, b) {
  if (a.aisle === b.aisle) return Math.abs(a.slot - b.slot);
  return a.slot + b.slot + 10 * Math.abs(aisleIndex(a.aisle) - aisleIndex(b.aisle));
}

// Normalise a raw move definition. Missing aisles/energy/duration are derived.
export function normalizeMove(raw) {
  if (!raw || typeof raw.id !== 'string' || raw.id === '') {
    throw new Error(`move requires a string id: ${JSON.stringify(raw)}`);
  }
  const from = parseLoc(raw.from);
  const to = parseLoc(raw.to);
  const aisles = raw.aisles !== undefined
    ? raw.aisles.slice()
    : [...new Set([from.aisle, to.aisle])];
  if (!Array.isArray(aisles) || aisles.some((a) => typeof a !== 'string')) {
    throw new Error(`move ${raw.id}: aisles must be strings`);
  }
  const dist = distance(from, to);
  const energy = raw.energy !== undefined ? raw.energy : dist;
  const duration = raw.duration !== undefined ? raw.duration : dist;
  for (const [name, v] of [['energy', energy], ['duration', duration]]) {
    if (!Number.isFinite(v) || v < 0) throw new Error(`move ${raw.id}: ${name} must be >= 0`);
  }
  return { id: raw.id, from, to, aisles, energy, duration };
}

// Signature used to match a planned move against the reusable-move pool.
export function moveSignature(m) {
  return `${locKey(m.from)}>${locKey(m.to)}@${m.aisles.join(',')}`;
}

export function normalizeShuttle(raw) {
  if (!raw || typeof raw.id !== 'string' || raw.id === '') {
    throw new Error(`shuttle requires a string id: ${JSON.stringify(raw)}`);
  }
  return {
    id: raw.id,
    home: parseLoc(raw.home),
    speed: raw.speed !== undefined ? raw.speed : 1,
    energyPerUnit: raw.energyPerUnit !== undefined ? raw.energyPerUnit : 1,
  };
}
