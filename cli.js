#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { parseArgs } = require('node:util');
const { FreezeEngine, FreezeError } = require('./src/engine');

const DEFAULT_STATE = '.freeze-state.json';

const USAGE = `usage: freeze <command> [options]

commands:
  load <file>            load batch graph JSON ({"edges": [[child, parent], ...], "merge"?: bool})
  hold --id --lot --type [--severity N]   add a hold (type: supplier|customer; severity may be null)
  release --id           release a hold (incremental, undoable)
  query [--lot]          show freeze status (severity + reasons) for one or all lots
  undo                   restore the most recent transaction

options:
  --state <path>         state file (default: ${DEFAULT_STATE}, or FREEZE_STATE env)
`;

function resolveStatePath(flagValue, env, cwd) {
  if (flagValue) return flagValue;
  if (env && env.FREEZE_STATE) return env.FREEZE_STATE;
  return path.resolve(cwd, DEFAULT_STATE);
}

function loadState(file) {
  if (!fs.existsSync(file)) {
    throw new FreezeError(`no state found at ${file}; run "load" first`);
  }
  return FreezeEngine.fromJSON(JSON.parse(fs.readFileSync(file, 'utf8')));
}

function saveState(file, engine) {
  fs.writeFileSync(file, JSON.stringify(engine.toJSON(), null, 2) + '\n');
}

// Runs one CLI invocation in-process. Returns { code, stdout, stderr } so it
// can be driven both by the bin wrapper and by tests.
function run(argv, { cwd = process.cwd(), env = process.env } = {}) {
  const emit = { stdout: '', stderr: '' };
  const print = (value) => {
    emit.stdout += JSON.stringify(value, null, 2) + '\n';
  };

  try {
    const [command, ...rest] = argv;
    if (!command || command === 'help' || command === '--help') {
      emit.stdout += USAGE;
      return { code: 0, ...emit };
    }

    if (command === 'load') {
      const { values, positionals } = parseArgs({
        args: rest,
        allowPositionals: true,
        options: { state: { type: 'string' } },
      });
      const file = positionals[0];
      if (!file) throw new FreezeError('load requires a graph JSON file');
      const spec = JSON.parse(fs.readFileSync(path.resolve(cwd, file), 'utf8'));
      const stateFile = resolveStatePath(values.state, env, cwd);
      let engine;
      try {
        engine = loadState(stateFile);
      } catch {
        engine = new FreezeEngine();
      }
      // The graph is validated before any state is committed: a cyclic input
      // fails here and the previous state file is left untouched.
      const result = spec.merge ? engine.addEdges(spec.edges || []) : engine.loadGraph(spec);
      for (const hold of spec.holds || []) engine.addHold(hold);
      saveState(stateFile, engine);
      print({ ok: true, ...result });
      return { code: 0, ...emit };
    }

    const { values } = parseArgs({
      args: rest,
      options: {
        state: { type: 'string' },
        id: { type: 'string' },
        lot: { type: 'string' },
        type: { type: 'string' },
        severity: { type: 'string' },
      },
    });
    const stateFile = resolveStatePath(values.state, env, cwd);
    const engine = loadState(stateFile);

    if (command === 'hold') {
      let severity = null;
      if (values.severity !== undefined && values.severity !== 'null') {
        severity = Number(values.severity);
        if (Number.isNaN(severity)) throw new FreezeError(`invalid severity: ${values.severity}`);
      }
      const hold = engine.addHold({ id: values.id, lot: values.lot, type: values.type, severity });
      saveState(stateFile, engine);
      print({ ok: true, hold });
      return { code: 0, ...emit };
    }

    if (command === 'release') {
      const hold = engine.releaseHold(values.id);
      saveState(stateFile, engine);
      print({ ok: true, released: hold });
      return { code: 0, ...emit };
    }

    if (command === 'query') {
      print(engine.query(values.lot ?? null));
      return { code: 0, ...emit };
    }

    if (command === 'undo') {
      const result = engine.undo();
      saveState(stateFile, engine);
      print({ ok: true, ...result });
      return { code: 0, ...emit };
    }

    throw new FreezeError(`unknown command: ${command}`);
  } catch (err) {
    emit.stderr = `error: ${err instanceof Error ? err.message : String(err)}\n`;
    return { code: 1, ...emit };
  }
}

module.exports = { run };

if (require.main === module) {
  const { code, stdout, stderr } = run(process.argv.slice(2));
  if (stdout) process.stdout.write(stdout);
  if (stderr) process.stderr.write(stderr);
  process.exitCode = code;
}
