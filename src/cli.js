#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const { EvidenceEngine, DEFAULT_BUDGET, stableStringify } = require('./engine');
const { ParseError, QueryTypeError, RegexCompileError, BudgetExceededError } = require('./errors');

const EXIT_OK = 0;
const EXIT_RUNTIME = 1;   // budget exceeded / runtime failure
const EXIT_COMPILE = 2;   // parse, type or regex errors
const EXIT_USAGE = 3;

const USAGE = `Usage:
  node src/cli.js run --records <file> --schema <file> --query <q> [--budget N] [--state <file>]
  node src/cli.js undo [--state <file>]
  node src/cli.js redo [--state <file>]
  node src/cli.js status [--state <file>]

Exit codes: 0 ok, 1 runtime error (budget exceeded), 2 compile error
(parse/type/regex), 3 usage or I/O error.`;

function parseArgs(argv) {
  const [command, ...rest] = argv;
  const opts = { _: [] };
  for (let i = 0; i < rest.length; i += 1) {
    const arg = rest[i];
    if (arg.startsWith('--')) {
      const key = arg.slice(2);
      const value = rest[i + 1];
      if (value === undefined || value.startsWith('--')) {
        throw new Error(`Missing value for --${key}`);
      }
      opts[key] = value;
      i += 1;
    } else {
      opts._.push(arg);
    }
  }
  return { command, opts };
}

function readJson(file, label) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (err) {
    throw new Error(`Cannot read ${label} from ${file}: ${err.message}`);
  }
}

function printVersion(version) {
  if (!version) {
    console.log('no version selected');
    return;
  }
  console.log(`hits: ${version.hits.length ? version.hits.join(' ') : '(none)'}`);
  console.log(`instructions: ${version.certificate.instructions}`);
  console.log('certificate:');
  console.log(JSON.stringify(version.certificate, null, 2));
}

function loadState(stateFile) {
  if (!fs.existsSync(stateFile)) return null;
  return EvidenceEngine.fromJSON(readJson(stateFile, 'state file'));
}

function saveState(stateFile, engine) {
  fs.writeFileSync(stateFile, `${JSON.stringify(engine.toJSON(), null, 2)}\n`);
}

function main(argv) {
  const { command, opts } = parseArgs(argv);
  const stateFile = opts.state || 'evq-state.json';

  switch (command) {
    case 'run': {
      if (!opts.query) throw new Error('--query is required');
      let engine = null;
      const prior = loadState(stateFile);
      if (opts.records && opts.schema) {
        const records = readJson(path.resolve(opts.records), 'records');
        const schema = readJson(path.resolve(opts.schema), 'schema');
        if (
          prior &&
          stableStringify(prior.records) === stableStringify(records) &&
          stableStringify(prior.schema) === stableStringify(schema)
        ) {
          engine = prior; // keep version history for identical inputs
        } else {
          engine = new EvidenceEngine({ schema, records });
        }
      } else if (prior) {
        engine = prior;
      } else {
        throw new Error('--records and --schema are required when no state file exists');
      }
      const budget = opts.budget === undefined ? engine.budget : Number(opts.budget);
      if (!Number.isInteger(budget) || budget < 0) {
        throw new Error(`--budget must be a non-negative integer, got '${opts.budget}'`);
      }
      const version = engine.run(opts.query, { budget });
      saveState(stateFile, engine); // only reached on success
      printVersion(version);
      return EXIT_OK;
    }
    case 'undo':
    case 'redo': {
      const engine = loadState(stateFile);
      if (!engine) throw new Error(`No state file at ${stateFile}; run a query first`);
      const version = command === 'undo' ? engine.undo() : engine.redo();
      saveState(stateFile, engine);
      printVersion(version);
      return EXIT_OK;
    }
    case 'status': {
      const engine = loadState(stateFile);
      if (!engine) throw new Error(`No state file at ${stateFile}`);
      console.log(`versions: ${engine.versions.length}, current: ${engine.current + 1}`);
      printVersion(engine.currentVersion());
      return EXIT_OK;
    }
    default:
      console.error(USAGE);
      return EXIT_USAGE;
  }
}

if (require.main === module) {
  let code;
  try {
    code = main(process.argv.slice(2));
  } catch (err) {
    if (err instanceof BudgetExceededError) {
      console.error(`runtime error: ${err.message}`);
      code = EXIT_RUNTIME;
    } else if (
      err instanceof ParseError ||
      err instanceof QueryTypeError ||
      err instanceof RegexCompileError
    ) {
      console.error(`compile error: ${err.message}`);
      code = EXIT_COMPILE;
    } else {
      console.error(`error: ${err.message}`);
      code = EXIT_USAGE;
    }
  }
  process.exit(code);
}

module.exports = { main, DEFAULT_BUDGET };
