#!/usr/bin/env node
// Usage:
//   node src/cli.js run <script.json> [--check]
//
// Script format:
//   {
//     "config": { "totalCap": 1000, "categoryCaps": {"A": 700}, "period": {"origin": 0, "length": 1440, "count": 3} },
//     "steps": [
//       { "op": "freeze", "id": "F1", "category": "A", "amount": 400, "start": 1000, "end": 2000 },
//       { "batch": [ <req>, <req>, ... ] },
//       { "op": "advance", "now": 2001 }
//     ]
//   }
import { readFileSync } from 'node:fs';
import { LimitEngine } from './engine.js';

function main(argv) {
  const [cmd, file, ...flags] = argv;
  if (cmd !== 'run' || !file) {
    console.error('usage: node src/cli.js run <script.json> [--check]');
    process.exit(2);
  }
  const check = flags.includes('--check');
  const script = JSON.parse(readFileSync(file, 'utf8'));
  const engine = new LimitEngine(script.config);
  let stepNo = 0;
  let rejected = 0;
  for (const step of script.steps) {
    const batch = step.batch ?? [step];
    const results = engine.submit(batch);
    for (const r of results) {
      stepNo++;
      if (!r.ok) rejected++;
      console.log(`step ${String(stepNo).padStart(2, '0')} | ${JSON.stringify(r)}`);
    }
  }
  console.log('final | ' + JSON.stringify(engine.status()));
  if (check) {
    let maxOcc = 0;
    for (let t = engine.domainStart; t < engine.domainEnd; t++) {
      const occ = engine.occupancyAt(t);
      if (occ > engine.totalCap) {
        console.error(`CHECK FAILED at minute ${t}: occupancy ${occ} > totalCap ${engine.totalCap}`);
        process.exit(1);
      }
      if (occ > maxOcc) maxOcc = occ;
    }
    for (const row of engine.periodUsage()) {
      const cap = engine.categoryCaps[row.category];
      if (cap !== undefined && row.usage > cap) {
        console.error(`CHECK FAILED at period ${row.period} category ${row.category}: ${row.usage} > ${cap}`);
        process.exit(1);
      }
    }
    const minutes = engine.domainEnd - engine.domainStart;
    console.log(`CHECK OK: ${minutes} minutes enumerated, max occupancy ${maxOcc}/${engine.totalCap}`);
  }
  if (rejected > 0) console.log(`rejected: ${rejected}`);
}

main(process.argv.slice(2));
