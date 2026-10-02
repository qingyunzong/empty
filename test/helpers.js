'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { Store } = require('../src/store');
const { Engine } = require('../src/engine');

function makeEngine(hooks = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mold-'));
  const file = path.join(dir, 'state.json');
  const store = new Store(file, hooks);
  const engine = new Engine(store);
  return { engine, store, file, dir };
}

const MON = '2026-10-05'; // Monday
const TUE = '2026-10-06';
const WED = '2026-10-07';
const THU = '2026-10-08';
const FRI = '2026-10-09';

function moldCfg(overrides = {}) {
  return {
    id: 'M1',
    cycleMinutes: 300,
    maintenanceMinutes: 45,
    startTime: `${MON}T08:00:00Z`,
    calendar: {
      workdays: [MON, TUE, WED, THU, FRI],
      start: '08:00',
      end: '17:00',
      shifts: [['08:00', '09:00']],
    },
    ...overrides,
  };
}

module.exports = { makeEngine, moldCfg, MON, TUE, WED, THU, FRI };
