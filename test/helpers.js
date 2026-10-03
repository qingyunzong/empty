import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

export function baseConfig() {
  return {
    calendar: {
      date: '2026-10-05',
      shifts: [
        { id: 'S1', start: '06:00', end: '14:00' },
        { id: 'S2', start: '14:00', end: '22:00' },
        { id: 'S3', start: '22:00', end: '06:00' },
      ],
    },
    capabilities: {
      WC1: { S1: 480, S2: 480, S3: 480 },
      WC2: { S1: 240, S2: 240, S3: 240 },
    },
    materials: { M1: 100, M2: 50 },
    policy: {
      defaultPermission: 'allow',
      permissions: { productLines: {}, workCenters: {}, workOrders: {} },
      actors: { planner: 1, supervisor: 2 },
      supervisorRank: 2,
    },
    orders: [
      { id: 'W1', productLine: 'PL1', workCenter: 'WC1', dueShift: 'S3', minutes: 120, materials: { M1: 10 } },
      { id: 'W2', productLine: 'PL1', workCenter: 'WC1', dueShift: 'S3', minutes: 120, materials: { M1: 10, M2: 5 } },
      { id: 'W3', productLine: 'PL2', workCenter: 'WC2', dueShift: 'S1', minutes: 60, materials: { M2: 5 } },
    ],
  };
}

export function writeConfig(dir, cfg) {
  mkdirSync(dir, { recursive: true });
  for (const k of ['calendar', 'capabilities', 'materials', 'policy', 'orders']) {
    writeFileSync(path.join(dir, k + '.json'), JSON.stringify(cfg[k], null, 2));
  }
}

export function tmpDir() {
  return mkdtempSync(path.join(tmpdir(), 'gate-'));
}

export function writeEvents(dir, events) {
  const file = path.join(dir, 'release.jsonl');
  writeFileSync(file, events.map((e) => JSON.stringify(e)).join('\n') + '\n');
  return file;
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
