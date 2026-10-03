#!/usr/bin/env node
// Offline AGV charging scheduler CLI.
//
//   node cli.js run <scenario.json>      ingest events in array order, print report
//   node cli.js permute <scenario.json>  enumerate all legal arrival orderings
//                                        (<= 6 events) and verify identical results
//
// Scenario format:
// {
//   "config": { "sitePowerKw", "cutoffTs", "chargers": [{"id","maxPowerKw"}],
//               "tenants": {"T1": {"dailyMinutesCap"}}, "vehicles": {"V1": {"tenantId"}} },
//   "events": [ {"eventId","vehicleId","seq","ts","type":"charge_request",
//                "minutes","powerKw","priority"?,"arrivalTs"?} |
//               {"eventId","vehicleId","seq","ts","type":"charge_release","arrivalTs"?} ]
// }
// Array order is the arrival order; arrivalTs defaults to 1-based index.

import { readFileSync } from 'node:fs';
import { Fleet } from './src/fleet.js';
import { verifyOrderInvariance } from './src/permute.js';

const [cmd, file] = process.argv.slice(2);
if (!cmd || !file || !['run', 'permute'].includes(cmd)) {
  console.error('usage: node cli.js <run|permute> <scenario.json>');
  process.exit(2);
}

const scenario = JSON.parse(readFileSync(file, 'utf8'));

if (cmd === 'run') {
  const fleet = new Fleet(scenario.config);
  for (const [i, ev] of scenario.events.entries()) {
    fleet.ingest(ev, ev.arrivalTs ?? i + 1);
  }
  console.log(JSON.stringify(fleet.report(), null, 2));
} else {
  const result = verifyOrderInvariance(scenario.config, scenario.events);
  console.log(JSON.stringify(result, null, 2));
  process.exitCode = result.ok ? 0 : 1;
}
