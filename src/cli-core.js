'use strict';

const fs = require('node:fs');
const { parseArgs } = require('node:util');
const { EvidenceEngine, DEFAULT_BUDGET } = require('./engine');
const { QueryError } = require('./errors');

const USAGE = `Usage: node cli.js --records <file> --schema <file> [options]

Options:
  --query <string>   query to execute
  --budget <n>       instruction budget (default ${DEFAULT_BUDGET})
  --state <file>     persist version history to a state file
  --undo             move to previous version
  --redo             move to next version
  --help             show this help
`;

function defaultIo() {
  return {
    stdout: (text) => process.stdout.write(text),
    stderr: (text) => process.stderr.write(text),
    readJson: (path) => JSON.parse(fs.readFileSync(path, 'utf8')),
    writeFile: (path, content) => fs.writeFileSync(path, content),
    exists: (path) => fs.existsSync(path),
  };
}

function printResult(io, certificate) {
  if (!certificate) {
    io.stdout('no version selected\n');
    return;
  }
  const output = {
    hits: certificate.hits,
    instructions: certificate.instructions,
    certificate,
  };
  io.stdout(`${JSON.stringify(output, null, 2)}\n`);
}

function runCli(argv, io = defaultIo()) {
  try {
    const { values } = parseArgs({
      args: argv,
      options: {
        records: { type: 'string' },
        schema: { type: 'string' },
        query: { type: 'string' },
        budget: { type: 'string' },
        state: { type: 'string' },
        undo: { type: 'boolean', default: false },
        redo: { type: 'boolean', default: false },
        help: { type: 'boolean', default: false },
      },
    });

    if (values.help) {
      io.stdout(USAGE);
      return 0;
    }
    if (!values.records || !values.schema) {
      io.stderr(USAGE);
      return 1;
    }

    const records = io.readJson(values.records);
    const schema = io.readJson(values.schema);
    const budget = values.budget !== undefined ? Number(values.budget) : DEFAULT_BUDGET;

    let state = null;
    if (values.state && io.exists(values.state)) {
      state = io.readJson(values.state);
    }
    const engine = EvidenceEngine.fromState(state, { schema, records, budget });

    const actions = [values.query !== undefined, values.undo, values.redo].filter(Boolean).length;
    if (actions > 1) {
      throw new QueryError('choose only one of --query, --undo, --redo', 'USAGE');
    }

    let certificate;
    if (values.undo) {
      certificate = engine.undo();
    } else if (values.redo) {
      certificate = engine.redo();
    } else if (values.query !== undefined) {
      certificate = engine.query(values.query, budget);
    } else {
      certificate = engine.current();
    }

    if (values.state) {
      io.writeFile(values.state, `${JSON.stringify(engine.toJSON(), null, 2)}\n`);
    }
    printResult(io, certificate);
    return 0;
  } catch (err) {
    const code = err instanceof QueryError ? err.code : 'ERROR';
    io.stderr(`${code}: ${err.message}\n`);
    return 1;
  }
}

module.exports = { runCli, USAGE };
