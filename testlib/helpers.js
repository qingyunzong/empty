'use strict';

const { TzRegistry } = require('../src/index');

const ZONE = 'Merchant/Test';

const tableFixedPlus8 = (version) => ({
  version,
  zones: { [ZONE]: { transitions: [{ utc: '2020-01-01T00:00:00Z', offsetMinutes: 480 }] } },
});

// v2 simulates a tzdb update: offset changes from +8 to +7 at 2024-06-01.
const tableShifted = {
  version: 'v2',
  zones: {
    [ZONE]: {
      transitions: [
        { utc: '2020-01-01T00:00:00Z', offsetMinutes: 480 },
        { utc: '2024-06-01T00:00:00Z', offsetMinutes: 420 },
      ],
    },
  },
};

// DST table: spring-forward gap 2024-03-31 02:00-03:00 local,
// fall-back overlap 2024-10-27 02:00-03:00 local.
const tableDst = {
  version: 'dst1',
  zones: {
    [ZONE]: {
      transitions: [
        { utc: '2024-01-01T00:00:00Z', offsetMinutes: 60 },
        { utc: '2024-03-31T01:00:00Z', offsetMinutes: 120 },
        { utc: '2024-10-27T01:00:00Z', offsetMinutes: 60 },
      ],
    },
  },
};

function registryWith(spec) {
  const r = new TzRegistry();
  for (const [purpose, tables] of Object.entries(spec)) {
    for (const t of tables) r.register(purpose, t);
  }
  return r;
}

module.exports = { ZONE, tableFixedPlus8, tableShifted, tableDst, registryWith };
