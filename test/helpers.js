import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export function tmpdir(prefix = 'biospec-test-') {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

export function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export const TYPES = ['blood', 'tissue', 'dna', 'rna', 'plasma', 'urine'];
export const STATUSES = ['stored', 'in-use', 'depleted', 'archived'];

export function randomDate(rng) {
  const start = Date.UTC(2023, 0, 1);
  const end = Date.UTC(2025, 11, 31);
  const d = new Date(start + Math.floor(rng() * (end - start)));
  return d.toISOString().slice(0, 10);
}

export function randomSample(rng, id) {
  return {
    id: String(id),
    type: TYPES[Math.floor(rng() * TYPES.length)],
    date: randomDate(rng),
    location: `F${1 + Math.floor(rng() * 5)}-R${1 + Math.floor(rng() * 20)}`,
    status: STATUSES[Math.floor(rng() * STATUSES.length)],
  };
}

export function randomPatch(rng) {
  const patch = {};
  if (rng() < 0.5) patch.type = TYPES[Math.floor(rng() * TYPES.length)];
  if (rng() < 0.5) patch.date = randomDate(rng);
  if (rng() < 0.5) patch.location = `F${1 + Math.floor(rng() * 5)}-R${1 + Math.floor(rng() * 20)}`;
  if (rng() < 0.5) patch.status = STATUSES[Math.floor(rng() * STATUSES.length)];
  if (Object.keys(patch).length === 0) patch.status = STATUSES[Math.floor(rng() * STATUSES.length)];
  return patch;
}

// Brute-force reference: filter the reference map directly.
export function refScan(ref, { type = null, from = null, to = null } = {}) {
  return [...ref.values()]
    .filter((r) => type == null || r.type === type)
    .filter((r) => from == null || r.date >= from)
    .filter((r) => to == null || r.date <= to)
    .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}
