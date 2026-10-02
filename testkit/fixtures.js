'use strict';

const { Lab } = require('../src/lab.js');

const AT = '2026-10-02T00:00:00.000Z';

// A fully valid lab: U1 -(U1->S1->ROOT), one measured point P1.
// combined uncertainty = sqrt(0.005^2 + 0.001^2 + 0.002^2) ~= 0.005477
function baseLab() {
  const lab = new Lab();
  lab.addArtifact({ id: 'ROOT', kind: 'standard', root: true, rangeClass: 'R1', envClass: 'E1', grade: 'G1', uncertainty: 0.001 });
  lab.addArtifact({
    id: 'S1', kind: 'standard', rangeClass: 'R1', envClass: 'E1', grade: 'G1',
    uncertainty: 0.005, validFrom: '2025-01-01', validTo: '2028-01-01',
  });
  lab.addArtifact({ id: 'U1', kind: 'uut', rangeClass: 'R1', envClass: 'E1', grade: 'G1' });
  lab.addArtifact({
    id: 'P1', kind: 'point', uutId: 'U1', rangeClass: 'R1', envClass: 'E1', grade: 'G1',
    budget: 0.02, window: { tempMin: 18, tempMax: 26, humMin: 30, humMax: 60 },
  });
  lab.link('U1', 'S1');
  lab.link('S1', 'ROOT');
  lab.measure({ pointId: 'P1', value: 10.001, temp: 21, humidity: 45, uMeas: 0.002, at: '2026-10-01T00:00:00.000Z' });
  return lab;
}

// Deterministic PRNG (mulberry32) for reproducible property tests.
function rng(seed) {
  let s = seed | 0;
  return function next() {
    s = (s + 0x6d2b79f5) | 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

module.exports = { AT, baseLab, rng };
