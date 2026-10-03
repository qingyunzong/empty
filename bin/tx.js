#!/usr/bin/env node
import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import {
  applyCommand, checkInvariants, initialState, verifyMigrationChain, EXIT,
} from '../src/ledger.js';

function usage() {
  console.error('usage:');
  console.error('  tx apply <cmd.json> [--state <path>]   apply a command to the ledger state');
  console.error('  tx verify [--state <path>]             verify migration hash chain and invariants');
  process.exit(EXIT.USAGE);
}

function parseArgs(argv) {
  const positional = [];
  let statePath = 'state.json';
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--state') {
      if (i + 1 >= argv.length) usage();
      statePath = argv[i + 1];
      i += 1;
    } else {
      positional.push(argv[i]);
    }
  }
  return { positional, statePath };
}

function loadState(path) {
  if (!existsSync(path)) return initialState();
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch (err) {
    console.error(`tx: cannot read state file ${path}: ${err.message}`);
    process.exit(EXIT.USAGE);
  }
}

function saveState(path, state) {
  const tmp = `${path}.tmp-${process.pid}`;
  writeFileSync(tmp, `${JSON.stringify(state, null, 2)}\n`);
  renameSync(tmp, path);
}

function main() {
  const { positional, statePath } = parseArgs(process.argv.slice(2));
  const action = positional[0];

  if (action === 'apply') {
    const cmdPath = positional[1];
    if (!cmdPath) usage();
    let cmd;
    try {
      cmd = JSON.parse(readFileSync(cmdPath, 'utf8'));
    } catch (err) {
      console.error(`tx: cannot read command file ${cmdPath}: ${err.message}`);
      process.exit(EXIT.USAGE);
    }
    const state = loadState(statePath);
    const outcome = applyCommand(state, cmd);
    saveState(statePath, state);
    const report = { ok: outcome.ok, exitCode: outcome.exitCode, replayed: outcome.replayed };
    if (outcome.ok) report.result = outcome.result;
    else report.error = outcome.error;
    console.log(JSON.stringify(report));
    if (!outcome.ok) console.error(`tx: ${outcome.error}`);
    process.exitCode = outcome.exitCode;
    return;
  }

  if (action === 'verify') {
    const state = loadState(statePath);
    const chainOk = verifyMigrationChain(state);
    const problems = checkInvariants(state);
    const ok = chainOk && problems.length === 0;
    console.log(JSON.stringify({ ok, chainOk, problems, migrations: state.migrations.length }));
    process.exitCode = ok ? EXIT.OK : EXIT.USAGE;
    return;
  }

  usage();
}

main();
