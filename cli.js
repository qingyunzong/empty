#!/usr/bin/env node
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { TraceabilitySystem } = require('./src/system');

// Exit code 4 is reserved for the three data-integrity failures:
// cyclic genealogy, unknown parent batch, layer number hole.
const EXIT_DATA_INTEGRITY = 4;
const INTEGRITY_KINDS = new Set(['CYCLIC_GENEALOGY', 'UNKNOWN_PARENT', 'LAYER_HOLE']);

function exitCodeFor(err) {
  return err && INTEGRITY_KINDS.has(err.kind) ? EXIT_DATA_INTEGRITY : 1;
}

function main(argv) {
  const positional = [];
  let stateDir = null;
  for (let i = 2; i < argv.length; i++) {
    if (argv[i] === '--state') {
      stateDir = argv[++i];
    } else {
      positional.push(argv[i]);
    }
  }
  if (positional.length !== 1) {
    process.stderr.write('usage: node cli.js <cmd.jsonl> [--state <dir>]\n');
    process.exit(2);
  }
  const cmdFile = positional[0];
  const baseDir = path.dirname(path.resolve(cmdFile));
  const sys = new TraceabilitySystem(stateDir || cmdFile + '.state');

  // Crash recovery runs first: only complete layers are replayed.
  const { recoveredTo } = sys.recover();
  console.log(JSON.stringify({ cmd: 'recover', recoveredTo }));

  const lines = fs
    .readFileSync(cmdFile, 'utf8')
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l.length > 0);
  for (const line of lines) {
    const cmd = JSON.parse(line);
    switch (cmd.cmd) {
      case 'import': {
        const r = sys.importFile(path.resolve(baseDir, cmd.file));
        console.log(JSON.stringify({ cmd: 'import', ...r }));
        break;
      }
      case 'equiv': {
        const r = sys.equivFiles(path.resolve(baseDir, cmd.a), path.resolve(baseDir, cmd.b));
        console.log(JSON.stringify({ cmd: 'equiv', ...r }));
        break;
      }
      case 'rollback': {
        const r = sys.rollback(cmd.layer);
        console.log(JSON.stringify({ cmd: 'rollback', ...r }));
        break;
      }
      default:
        throw Object.assign(new Error(`unknown command "${cmd.cmd}"`), { kind: 'BAD_COMMAND' });
    }
  }
}

try {
  main(process.argv);
} catch (err) {
  console.log(JSON.stringify({ error: err.message, kind: err.kind || 'ERROR' }));
  process.exit(exitCodeFor(err));
}
