#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const { explore } = require('../src/explorer');

function readJson(path, code, io) {
  try {
    return JSON.parse(fs.readFileSync(path, 'utf8'));
  } catch (e) {
    io.stderr(`${code}: cannot read ${path}: ${e.message}`);
    return undefined;
  }
}

function main(argv, io = { stdout: (s) => console.log(s), stderr: (s) => console.error(s) }) {
  const [treePath, actorsPath] = argv;
  if (!treePath || !actorsPath) {
    io.stderr('usage: explree tree.json actors.json');
    return 2;
  }
  const treeSpec = readJson(treePath, 'INVALID_TREE', io);
  if (treeSpec === undefined) return 2;
  const actorsSpec = readJson(actorsPath, 'INVALID_ACTORS', io);
  if (actorsSpec === undefined) return 2;
  const actors = Array.isArray(actorsSpec) ? actorsSpec : actorsSpec.actors;
  let result;
  try {
    result = explore(treeSpec, actors);
  } catch (e) {
    io.stderr(`${e.code || 'ERROR'}: ${e.message}`);
    return 2;
  }
  io.stdout(JSON.stringify(result, null, 2));
  return result.safe ? 0 : 1;
}

if (require.main === module) {
  process.exitCode = main(process.argv.slice(2));
}

module.exports = { main };
