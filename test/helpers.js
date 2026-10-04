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

// Three-shift plant: day 06-14, swing 14-22, night 22-06 (crosses midnight).
export function threeShiftConfig() {
  return {
    calendar: {
      shifts: [
        { name: 'day', start: '06:00', end: '14:00' },
        { name: 'swing', start: '14:00', end: '22:00' },
        { name: 'night', start: '22:00', end: '06:00' },
      ],
    },
    materials: {
      'M-1': { stock: 10 },
      'M-2': { stock: 4 },
    },
    productLines: {
      'PL-1': {
        permission: 'allow',
        workCenters: {
          'WC-1': {
            permission: 'inherit',
            capabilities: { assembly: 2 },
            orders: {
              'WO-1': { materials: { 'M-1': 1 }, capability: 'assembly', durationMin: 120 },
              'WO-2': { materials: { 'M-1': 1, 'M-2': 2 }, capability: 'assembly', durationMin: 480 },
              'WO-3': { materials: {}, capability: 'assembly', durationMin: 60 },
              'WO-4': { materials: { 'M-2': 1 }, capability: 'assembly', durationMin: 90 },
            },
          },
        },
      },
    },
    policy: { tieBreak: 'freeze-wins' },
  };
}

let tsCounter = 0;
export function ts(base = '2026-10-04T20:00:00Z', plusMin = 0) {
  return new Date(Date.parse(base) + plusMin * 60000).toISOString();
}

export function ev(type, extra = {}, plusMin = null) {
  tsCounter += 1;
  const offset = plusMin ?? tsCounter;
  return { ts: ts('2026-10-04T20:00:00Z', offset), type, ...extra };
}

export function resetEventClock() {
  tsCounter = 0;
}
