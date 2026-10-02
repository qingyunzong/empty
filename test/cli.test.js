'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { runCommands } = require('../cli');
const { moldCfg } = require('./helpers');

test('CLI runCommands processes JSON commands and persists across sessions', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mold-cli-'));
  const stateFile = path.join(dir, 'state.json');

  const out1 = runCommands([
    { cmd: 'addMold', mold: moldCfg({ id: 'M1', cycleMinutes: 100, maintenanceMinutes: 20 }) },
    { cmd: 'book', order: { id: 'O1', minutes: 90 } },
  ], stateFile);
  assert.equal(out1.length, 2);
  assert.ok(out1.every((r) => r.ok));
  assert.equal(out1[1].mold, 'M1');
  assert.ok(fs.existsSync(stateFile));

  // a fresh session reloads the persisted state file
  const out2 = runCommands([
    { cmd: 'book', order: { id: 'O2', minutes: 90 } },
    { cmd: 'state' },
  ], stateFile);
  assert.ok(out2[0].ok);
  const schedule = out2[1].molds.M1.schedule;
  assert.equal(schedule.filter((i) => i.type === 'maintenance').length, 1);
  assert.deepEqual(out2[1].molds.M1.queue, ['O1', 'O2']);
});

test('CLI reports per-command errors as JSON result objects', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mold-cli-'));
  const stateFile = path.join(dir, 'state.json');
  const out = runCommands([{ cmd: 'cancel', orderId: 'ghost' }], stateFile);
  assert.equal(out[0].ok, false);
  assert.match(out[0].error, /unknown order/);
});
