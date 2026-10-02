import { validatePolicies } from '../../src/policy.js';

export function makePolicy(obj) {
  return validatePolicies(structuredClone(obj));
}

export const BASE_POLICY = {
  roles: {
    anyone: {},
    user: { inherits: ['anyone'] },
    operator: { inherits: ['user'] },
    supervisor: { inherits: ['user'] },
  },
  zones: {
    plant: {},
    line1: { inherits: ['plant'] },
    cellA: { inherits: ['line1'] },
    cellB: { inherits: ['line1'] },
  },
  subjects: {
    alice: { roles: ['operator'] },
    bob: { roles: ['supervisor'] },
    carol: { roles: ['user'] },
  },
  devices: {
    press1: { zone: 'cellA' },
    press2: { zone: 'cellB' },
  },
  rules: [
    { id: 'r-base-open', effect: 'allow', action: 'openMold', role: 'anyone', zone: 'plant' },
    { id: 'r-deny-cellA', effect: 'deny', action: 'openMold', role: 'user', zone: 'cellA' },
    { id: 'r-heat-allow', effect: 'allow', action: 'heatUp', role: 'operator', zone: 'line1' },
    { id: 'r-heat-deny', effect: 'deny', action: 'heatUp', role: 'operator', zone: 'line1' },
    {
      id: 'r-reset-window', effect: 'allow', action: 'resetEstop', role: 'operator', zone: 'cellA',
      window: { start: '08:00', end: '18:00' },
    },
    { id: 'r-wild-deny', effect: 'deny', action: '*', role: 'anyone', zone: 'plant' },
  ],
};

export function buildFiftyRequests() {
  const subjects = ['alice', 'bob', 'carol'];
  const devices = ['press1', 'press2'];
  const actions = ['openMold', 'heatUp', 'resetEstop'];
  const requests = [];
  let n = 0;
  for (let round = 0; round < 3 && requests.length < 50; round += 1) {
    for (const subject of subjects) {
      for (const device of devices) {
        for (const action of actions) {
          if (requests.length >= 50) break;
          n += 1;
          const hour = 6 + ((n * 5 + round * 3) % 17); // 06:00 .. 22:00, crosses the 08-18 window
          requests.push({
            id: `rq-${String(n).padStart(3, '0')}`,
            subject,
            device,
            action,
            time: `2026-01-0${1 + (n % 5)}T${String(hour).padStart(2, '0')}:00:00Z`,
          });
        }
      }
    }
  }
  return requests;
}
