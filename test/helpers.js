import { appendRecord } from '../src/index.js';

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

export function siteLog(site, gen, steps) {
  const records = [];
  for (let i = 0; i < steps; i += 1) {
    records.push(appendRecord(records, {
      type: 'step',
      site,
      gen,
      payload: { op: `op-${i + 1}`, batch: 'B-100' },
    }));
  }
  return records;
}

export function shuffle(list, rand) {
  const out = [...list];
  for (let i = out.length - 1; i > 0; i -= 1) {
    const j = Math.floor(rand() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}
