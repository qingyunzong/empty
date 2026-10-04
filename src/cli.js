'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { runToollife, UnknownToolError } = require('./engine');
const { readJson, readJsonl, writeJson, writeJsonl } = require('./io');

function parseArgs(argv) {
  const args = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const key = a.slice(2);
      const next = argv[i + 1];
      if (next === undefined || next.startsWith('--')) {
        args[key] = true;
      } else {
        args[key] = next;
        i++;
      }
    } else {
      args._.push(a);
    }
  }
  return args;
}

function fail(message, code) {
  fs.writeSync(2, `error: ${message}\n`);
  return code;
}

function main(argv) {
  const args = parseArgs(argv);
  const command = args._[0];
  if (command !== 'toollife' || !args.in || !args.out) {
    fs.writeSync(2, 'usage: node cli.js toollife --in <dir> --out <dir>\n');
    return 1;
  }
  const inDir = args.in;
  const outDir = args.out;
  try {
    const config = readJson(path.join(inDir, 'tools.json'));
    const operations = readJsonl(path.join(inDir, 'operations.jsonl'));
    const undos = readJsonl(path.join(inDir, 'undo.jsonl'));
    const { toolsState, history } = runToollife(config, operations, undos);
    writeJson(path.join(outDir, 'tools_state.json'), { tools: toolsState });
    writeJsonl(path.join(outDir, 'history.jsonl'), history);
    return 0;
  } catch (err) {
    if (err instanceof UnknownToolError) return fail(err.message, 2);
    return fail(err.message, 1);
  }
}

module.exports = { main, parseArgs };
