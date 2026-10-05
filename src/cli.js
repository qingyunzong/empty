#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const {
  StaticError,
  checkScript,
  parseObservations,
  parseStateObservations,
  observationsToJson,
} = require('./types');
const { compile, dump } = require('./compiler');
const { runProgram } = require('./vm');

const EXIT_OK = 0;
const EXIT_ERROR = 1;
const EXIT_USAGE = 2;
const EXIT_CRASH = 75;

const USAGE = `usage: node src/cli.js --script <file> --obs <file> [--state <file>] [--dump] [--crash N]

  --script  JSON script: nested blocks containing transactions of assigns/guards
  --obs     JSON initial observations
  --state   state file for committed transactions (default: evidence-guard.state.json)
  --dump    print the compiled instruction listing to stderr
  --crash N exit with code ${EXIT_CRASH} after executing the Nth instruction (before any
            further commit); rerun without --crash to resume from the state file`;

class CrashExit extends Error {}

function parseArgs(argv) {
  const args = { script: null, obs: null, state: null, dump: false, crash: null, help: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--dump') args.dump = true;
    else if (a === '--script') args.script = argv[++i];
    else if (a === '--obs') args.obs = argv[++i];
    else if (a === '--state') args.state = argv[++i];
    else if (a === '--crash') args.crash = Number(argv[++i]);
    else if (a === '--help' || a === '-h') args.help = true;
    else throw new Error(`unknown argument: ${a}`);
  }
  if (args.crash !== null && (!Number.isInteger(args.crash) || args.crash < 1)) {
    throw new Error('--crash expects a positive integer');
  }
  return args;
}

function loadState(statePath) {
  const state = JSON.parse(fs.readFileSync(statePath, 'utf8'));
  return {
    committed: new Set(state.committed),
    base: parseStateObservations(state.observations),
  };
}

function saveState(statePath, committed, registers) {
  const observations = {};
  for (const [name, tv] of registers) observations[name] = { t: tv.t, v: tv.v };
  const data = {
    committed: [...committed].sort((a, b) => a - b),
    observations,
  };
  const tmp = statePath + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2) + '\n');
  fs.renameSync(tmp, statePath);
}

// Runs the CLI and returns { code, stdout, stderr } without touching the
// process, so tests can drive it in-process.
function run(argv) {
  let args;
  try {
    args = parseArgs(argv);
  } catch (e) {
    return { code: EXIT_USAGE, stdout: '', stderr: `error: ${e.message}\n${USAGE}\n` };
  }
  if (args.help) return { code: EXIT_OK, stdout: USAGE + '\n', stderr: '' };
  if (!args.script || !args.obs) {
    return {
      code: EXIT_USAGE,
      stdout: '',
      stderr: `error: --script and --obs are required\n${USAGE}\n`,
    };
  }

  const fail = (error, observations) => ({
    code: EXIT_ERROR,
    stdout: JSON.stringify({ ok: false, error, observations }, null, 2) + '\n',
    stderr: '',
  });

  let script;
  let obsJson;
  try {
    script = JSON.parse(fs.readFileSync(args.script, 'utf8'));
    obsJson = JSON.parse(fs.readFileSync(args.obs, 'utf8'));
  } catch (e) {
    return fail(`cannot read input: ${e.message}`, {});
  }

  const statePath = args.state || 'evidence-guard.state.json';
  const committed = new Set();
  let base;
  let resumed = false;
  try {
    if (fs.existsSync(statePath)) {
      const state = loadState(statePath);
      for (const seq of state.committed) committed.add(seq);
      base = state.base;
      resumed = true;
    } else {
      base = parseObservations(obsJson);
    }
  } catch (e) {
    return fail(`invalid state or observations: ${e.message}`, {});
  }

  try {
    checkScript(script, base.types);
  } catch (e) {
    if (e instanceof StaticError) return fail(`type error: ${e.message}`, {});
    throw e;
  }

  const instructions = compile(script);
  const dumpText = args.dump ? dump(instructions) + '\n' : '';

  const registers = base.registers;
  let result;
  try {
    result = runProgram(instructions, registers, base.types, {
      committedSeqs: committed,
      crashAt: args.crash,
      onCommit: (seq) => {
        committed.add(seq);
        saveState(statePath, committed, registers);
      },
      onCrash: (n) => {
        throw new CrashExit(
          `crash: executed ${n} instruction(s), exiting before any further commit\n`
        );
      },
    });
  } catch (e) {
    if (e instanceof CrashExit) {
      return { code: EXIT_CRASH, stdout: '', stderr: dumpText + e.message };
    }
    return fail(`runtime error: ${e.message}`, {});
  }

  const out = {
    ok: true,
    resumed,
    observations: observationsToJson(registers),
    committed: [...committed].sort((a, b) => a - b),
    rolledBack: result.rolledBack,
  };
  return { code: EXIT_OK, stdout: JSON.stringify(out, null, 2) + '\n', stderr: dumpText };
}

if (require.main === module) {
  const r = run(process.argv.slice(2));
  if (r.stdout) process.stdout.write(r.stdout);
  if (r.stderr) process.stderr.write(r.stderr);
  process.exit(r.code);
}

module.exports = { run, EXIT_OK, EXIT_ERROR, EXIT_USAGE, EXIT_CRASH };
