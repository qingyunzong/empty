#!/usr/bin/env node
// Offline CLI for the AGV fleet charging scheduler. Standard library only.
//
// Usage:
//   node cli.js run <scenario.json> [--out report.json]
//   node cli.js enumerate <scenario.json>
//
// Scenario format:
//   {
//     "config": { "sitePowerKw": 100, "piles": [...], "tenants": [...], "vehicles": [...] },
//     "events": [ { "seq": 1, "ts": 0, "type": "request", "vehicleId": "V1", "minutes": 60 } ],
//     "steps":  [ { "op": "ingest", "event": {...}, "arrival": 0 }, { "op": "settle", "ts": 100 } ]
//   }

import { writeFileSync } from 'node:fs';
import { loadScenario, runScenario } from './src/scenario.js';
import { checkOrderIndependence } from './src/enumerate.js';

function emit(payload, out) {
  const text = JSON.stringify(payload, null, 2);
  if (out) {
    writeFileSync(out, text + '\n');
    console.log(`written to ${out}`);
  } else {
    console.log(text);
  }
}

const [, , command, file, ...rest] = process.argv;
const outIdx = rest.indexOf('--out');
const out = outIdx >= 0 ? rest[outIdx + 1] : null;

if (!command || !file || !['run', 'enumerate'].includes(command)) {
  console.error('usage: node cli.js run|enumerate <scenario.json> [--out report.json]');
  process.exit(2);
}

let scenario;
try {
  scenario = loadScenario(file);
} catch (err) {
  console.error(`cannot load scenario ${file}: ${err.message}`);
  process.exit(2);
}

if (command === 'run') {
  emit(runScenario(scenario), out);
} else {
  const result = checkOrderIndependence(scenario.config, scenario.events ?? []);
  emit(result, out);
  if (!result.ok) process.exitCode = 1;
}
