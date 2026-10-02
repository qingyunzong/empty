'use strict';

const fs = require('node:fs');
const { applyCommand, verifyState } = require('./machine');
const { loadState, saveState } = require('./store');

const EXIT_USAGE = 2;

const USAGE =
  'usage:\n' +
  '  tx apply <cmd.json> [--state <state.json>]\n' +
  '  tx verify [--state <state.json>]\n';

function parseFlags(args) {
  const positional = [];
  let statePath = 'state.json';
  for (let i = 0; i < args.length; i += 1) {
    if (args[i] === '--state') {
      statePath = args[i + 1];
      i += 1;
      if (statePath === undefined) return null;
    } else {
      positional.push(args[i]);
    }
  }
  return { positional, statePath };
}

// Returns the process exit code. `io` may inject stdout/stderr writers.
function runCli(argv, io = {}) {
  const stdout = io.stdout || ((s) => process.stdout.write(s));
  const stderr = io.stderr || ((s) => process.stderr.write(s));

  const parsed = parseFlags(argv);
  if (!parsed) {
    stderr(USAGE);
    return EXIT_USAGE;
  }
  const { positional, statePath } = parsed;
  const command = positional[0];

  if (command === 'apply') {
    const cmdPath = positional[1];
    if (!cmdPath) {
      stderr(USAGE);
      return EXIT_USAGE;
    }
    let cmd;
    try {
      cmd = JSON.parse(fs.readFileSync(cmdPath, 'utf8'));
    } catch (err) {
      stderr(`cannot read command file: ${err.message}\n`);
      return EXIT_USAGE;
    }
    let state;
    try {
      state = loadState(statePath);
    } catch (err) {
      stderr(`cannot load state file: ${err.message}\n`);
      return EXIT_USAGE;
    }
    const result = applyCommand(state, cmd);
    // Persist even on failure so idempotency records of failed commands survive.
    saveState(statePath, state);
    stdout(`${JSON.stringify(result)}\n`);
    if (result.error) {
      stderr(`${result.error}\n`);
    }
    return result.code;
  }

  if (command === 'verify') {
    let state;
    try {
      state = loadState(statePath);
    } catch (err) {
      stderr(`cannot load state file: ${err.message}\n`);
      return EXIT_USAGE;
    }
    const report = verifyState(state);
    stdout(`${JSON.stringify(report)}\n`);
    return report.ok ? 0 : 1;
  }

  stderr(USAGE);
  return EXIT_USAGE;
}

module.exports = { runCli, EXIT_USAGE };
