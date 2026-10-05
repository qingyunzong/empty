#!/usr/bin/env node
'use strict';
// Chain-of-evidence audit CLI for the clinical-omics core facility.
//
//   node bin/cli.js register <log> --id S1 --kind sample --volume 100 --time <iso>
//   node bin/cli.js register <log> --id B1 --kind batch --reagent R1 [--compatible R1,R2]
//   node bin/cli.js aliquot  <log> --id A1 --parent S1 --volume 40 --time <iso>
//   node bin/cli.js assay    <log> --id X1 --parent A1 --batch B1 --reagent R1 --conclusion "..." --time <iso>
//   node bin/cli.js qc_fail  <log> --target A1 --time <iso>
//   node bin/cli.js revoke   <log> --target S1 --reason "..." --time <iso>
//   node bin/cli.js attest   <log> --target X1 --signature sig:... --time <iso>
//   node bin/cli.js verify   <log> [--budget N] [--now <iso>]
//   node bin/cli.js compact  <log>
//   node bin/cli.js recover  <log>

const { appendEvent, readLog, compact, recover } = require('../src/logio');
const { foldEvents } = require('../src/state');
const { verify } = require('../src/verify');

function parseArgs(argv) {
  const positional = [];
  const opts = {};
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i].startsWith('--')) {
      const key = argv[i].slice(2);
      opts[key] = argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[++i] : true;
    } else {
      positional.push(argv[i]);
    }
  }
  return { positional, opts };
}

function num(v) { return v === undefined ? undefined : Number(v); }

function main() {
  const { positional, opts } = parseArgs(process.argv.slice(2));
  const [cmd, log] = positional;
  if (!cmd || !log) {
    console.error('usage: cli.js <command> <log> [--flags]');
    process.exit(2);
  }

  switch (cmd) {
    case 'register':
      appendEvent(log, {
        type: 'register', id: opts.id, kind: opts.kind,
        volume: num(opts.volume), reagent: opts.reagent,
        compatible: opts.compatible ? opts.compatible.split(',') : undefined,
        time: opts.time || new Date().toISOString(),
      });
      break;
    case 'aliquot':
      appendEvent(log, { type: 'aliquot', id: opts.id, parent: opts.parent, volume: num(opts.volume), time: opts.time || new Date().toISOString() });
      break;
    case 'assay':
      appendEvent(log, { type: 'assay', id: opts.id, parent: opts.parent, batch: opts.batch, reagent: opts.reagent, conclusion: opts.conclusion || '', time: opts.time || new Date().toISOString() });
      break;
    case 'qc_fail':
      appendEvent(log, { type: 'qc_fail', target: opts.target, time: opts.time || new Date().toISOString() });
      break;
    case 'revoke':
      appendEvent(log, { type: 'revoke', target: opts.target, reason: opts.reason || '', time: opts.time || new Date().toISOString() });
      break;
    case 'attest':
      appendEvent(log, { type: 'attest', target: opts.target, signature: opts.signature || '', time: opts.time || new Date().toISOString() });
      break;
    case 'verify': {
      recover(log);
      const state = foldEvents(readLog(log));
      const { results, summary } = verify(state, {
        budget: opts.budget === undefined ? Infinity : Number(opts.budget),
        now: opts.now,
      });
      for (const r of results) {
        console.log(`${r.status}\t${r.assay}\t${r.reason}`);
        if (r.certificate) console.log(`  certificate: ${JSON.stringify(r.certificate)}`);
        if (r.core) console.log(`  broken-core: ${JSON.stringify(r.core)}`);
      }
      console.log(`summary: ${JSON.stringify(summary)}`);
      process.exit(summary.BROKEN > 0 ? 1 : 0); // PENDING is not BROKEN
      break;
    }
    case 'compact': {
      const { before, after } = compact(log);
      console.log(`compacted ${before} events -> ${after} snapshot event`);
      break;
    }
    case 'recover': {
      console.log(`recover: ${recover(log)}`);
      break;
    }
    default:
      console.error(`unknown command: ${cmd}`);
      process.exit(2);
  }
}

main();
