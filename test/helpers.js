'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

function tmpdir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'biobank-test-'));
}

// Deterministic PRNG (mulberry32) for reproducible workloads.
function prng(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const TYPES = ['blood', 'tissue', 'plasma', 'dna', 'urine'];
const STATUSES = ['stored', 'in-use', 'shipped', 'depleted'];
const LOCATIONS = ['freezer-A1', 'freezer-A2', 'fridge-B1', 'shelf-C3'];

function randomDate(rand) {
  const y = 2019 + Math.floor(rand() * 7);
  const m = 1 + Math.floor(rand() * 12);
  const d = 1 + Math.floor(rand() * 28);
  const mm = String(m).padStart(2, '0');
  const dd = String(d).padStart(2, '0');
  return `${y}-${mm}-${dd}`;
}

function randomSample(rand, id) {
  return {
    id,
    type: TYPES[Math.floor(rand() * TYPES.length)],
    date: randomDate(rand),
    location: LOCATIONS[Math.floor(rand() * LOCATIONS.length)],
    status: STATUSES[Math.floor(rand() * STATUSES.length)],
  };
}

// Brute-force reference: filter a plain map of expected records.
function bruteFind(ref, id) {
  return ref.has(id) ? { ...ref.get(id) } : null;
}

function bruteScanType(ref, type) {
  return [...ref.values()]
    .filter((s) => s.type === type)
    .sort((a, b) => (a.id < b.id ? -1 : 1))
    .map((s) => ({ ...s }));
}

function bruteScanDate(ref, from, to) {
  return [...ref.values()]
    .filter((s) => s.date >= from && s.date <= to)
    .sort((a, b) => (a.date === b.date
      ? (a.id < b.id ? -1 : 1)
      : (a.date < b.date ? -1 : 1)))
    .map((s) => ({ ...s }));
}

module.exports = {
  tmpdir, prng, TYPES, STATUSES, LOCATIONS,
  randomDate, randomSample, bruteFind, bruteScanType, bruteScanDate,
};
