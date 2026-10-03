'use strict';

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

function pick(rng, arr) {
  return arr[Math.floor(rng() * arr.length)];
}

const WELL_IDS = ['W1', 'W2', 'W3', 'W4', 'W5', 'W6', 'W7', 'W8']; // <= 8 wells per plate
const PLATE_IDS = ['A', 'B']; // two plates
const GROUP_IDS = ['G1', 'G2', 'G3'];

// Generate a random valid op given the current model (from the reference
// reducer). Keeps at most two plates and at most eight wells per plate.
function randomOp(rng, model) {
  const plates = [...model.plates.keys()];
  const groups = [...model.groups.keys()];
  const choices = [];
  const add = (weight, fn) => choices.push([weight, fn]);

  if (plates.length > 0) {
    add(30, () => ({
      type: 'setWell',
      plate: pick(rng, plates),
      well: pick(rng, WELL_IDS),
      value: Math.round(rng() * 300) / 100,
    }));
    add(8, () => {
      const plate = pick(rng, plates);
      const wells = [...model.plates.get(plate).wells.keys()];
      return wells.length
        ? { type: 'removeWell', plate, well: pick(rng, wells) }
        : { type: 'setWell', plate, well: pick(rng, WELL_IDS), value: 1 };
    });
    add(12, () => {
      const plate = pick(rng, plates);
      const wells = [...model.plates.get(plate).wells.keys()];
      const roll = rng();
      const well = roll < 0.15 && wells.length ? 'ZZ' : roll < 0.3 ? null : pick(rng, wells.length ? wells : WELL_IDS);
      return { type: 'setControl', plate, kind: rng() < 0.5 ? 'neg' : 'pos', well };
    });
  }
  if (plates.length < PLATE_IDS.length) {
    add(6, () => ({ type: 'addPlate', plate: PLATE_IDS.find((p) => !plates.includes(p)) }));
  }
  if (plates.length > 1) {
    add(2, () => ({ type: 'removePlate', plate: pick(rng, plates) }));
  }
  if (groups.length < GROUP_IDS.length) {
    add(8, () => ({ type: 'addGroup', group: GROUP_IDS.find((g) => !groups.includes(g)) }));
  }
  if (groups.length > 0) {
    add(3, () => ({ type: 'removeGroup', group: pick(rng, groups) }));
    const allWells = [];
    for (const [plate, p] of model.plates) for (const w of p.wells.keys()) allWells.push([plate, w]);
    if (allWells.length) {
      add(15, () => {
        const [plate, well] = pick(rng, allWells);
        return { type: 'addToGroup', group: pick(rng, groups), plate, well };
      });
      add(10, () => {
        const [plate, well] = pick(rng, allWells);
        const from = pick(rng, groups);
        let to = pick(rng, groups);
        return { type: 'moveWell', plate, well, from, to };
      });
    }
    const members = [];
    for (const g of groups) for (const key of model.groups.get(g)) members.push([g, key]);
    if (members.length) {
      add(8, () => {
        const [group, key] = pick(rng, members);
        const sep = key.indexOf('/');
        return { type: 'removeFromGroup', group, plate: key.slice(0, sep), well: key.slice(sep + 1) };
      });
    }
  }
  add(10, () => ({ type: 'undo' }));
  add(5, () => ({ type: 'redo' }));

  const total = choices.reduce((s, [w]) => s + w, 0);
  let roll = rng() * total;
  for (const [w, fn] of choices) {
    roll -= w;
    if (roll <= 0) return fn();
  }
  return choices[choices.length - 1][1]();
}

module.exports = { mulberry32, pick, randomOp, WELL_IDS, PLATE_IDS, GROUP_IDS };
