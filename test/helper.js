'use strict';

// Shared helpers for scenario generation (not a test file).

function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const NIGHTS = ['N1', 'N2'];
const INSTRUMENTS = ['camA', 'camB'];

function pick(rand, arr) {
  return arr[Math.floor(rand() * arr.length)];
}

function pickInt(rand, lo, hi) {
  return lo + Math.floor(rand() * (hi - lo + 1));
}

// Initial state: at most 2 nights, at most 5 frames per night.
function randomState(rand) {
  const state = { frames: [], calibrations: {}, weather: {} };
  for (const inst of INSTRUMENTS) {
    if (rand() < 0.8) {
      state.calibrations[inst] = {
        dark: pickInt(rand, 0, 4),
        flat: pick(rand, [0.5, 1, 2]),
      };
    }
  }
  for (const night of NIGHTS) {
    if (rand() < 0.7) {
      state.weather[night] = {
        status: pick(rand, ['clear', 'clear', 'degraded', 'blocked']),
        attenuation: pick(rand, [0.5, 1, 1, 2]),
      };
    }
    const count = pickInt(rand, 0, 5);
    for (let i = 0; i < count; i += 1) {
      state.frames.push({
        id: `${night}-f${i}`,
        night,
        instrument: pick(rand, INSTRUMENTS),
        signal: pickInt(rand, 0, 20),
      });
    }
  }
  return state;
}

// Generates a valid random op against the current engine state.
function randomOp(rand, state, nextId) {
  const frameIds = Object.keys(state.frames);
  const nightCounts = {};
  for (const f of Object.values(state.frames)) {
    nightCounts[f.night] = (nightCounts[f.night] || 0) + 1;
  }
  const choices = ['setCalibration', 'setWeather'];
  if (frameIds.length > 0) choices.push('removeFrame', 'regroup', 'regroup');
  if (NIGHTS.some((n) => (nightCounts[n] || 0) < 5)) choices.push('addFrame', 'addFrame');
  if (Object.keys(state.calibrations).length > 0) choices.push('removeCalibration');

  switch (pick(rand, choices)) {
    case 'addFrame': {
      const night = pick(rand, NIGHTS.filter((n) => (nightCounts[n] || 0) < 5));
      return {
        type: 'addFrame',
        frame: {
          id: `x${nextId()}`,
          night,
          instrument: pick(rand, INSTRUMENTS),
          signal: pickInt(rand, 0, 20),
        },
      };
    }
    case 'removeFrame':
      return { type: 'removeFrame', frameId: pick(rand, frameIds) };
    case 'regroup': {
      const op = { type: 'regroup', frameId: pick(rand, frameIds) };
      if (rand() < 0.7) op.night = pick(rand, NIGHTS);
      if (rand() < 0.5) op.instrument = pick(rand, INSTRUMENTS);
      return op;
    }
    case 'setCalibration': {
      const op = { type: 'setCalibration', instrument: pick(rand, INSTRUMENTS) };
      if (rand() < 0.8) op.dark = pickInt(rand, 0, 4);
      if (rand() < 0.8) op.flat = pick(rand, [0.5, 1, 2]);
      if (op.dark === undefined && op.flat === undefined) op.dark = 0;
      return op;
    }
    case 'removeCalibration':
      return { type: 'removeCalibration', instrument: pick(rand, Object.keys(state.calibrations)) };
    case 'setWeather':
    default: {
      const op = { type: 'setWeather', night: pick(rand, NIGHTS) };
      if (rand() < 0.8) op.status = pick(rand, ['clear', 'clear', 'degraded', 'blocked']);
      if (rand() < 0.5) op.attenuation = pick(rand, [0.5, 1, 2]);
      return op;
    }
  }
}

function randomBudget(rand) {
  return rand() < 0.2 ? pickInt(rand, 0, 4) : 1000;
}

module.exports = { mulberry32, NIGHTS, INSTRUMENTS, randomState, randomOp, randomBudget };
