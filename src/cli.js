#!/usr/bin/env node
'use strict';

// CLI: reads a JSON spec (file path argument or stdin) of the form
//   { "variables": { "a": "m", "t": "s" },
//     "commands": [ {"op":"correct","formula":"v=a/t"},
//                   {"op":"undo"}, {"op":"redo"},
//                   {"op":"status"}, {"op":"enumerate"} ] }
// and prints JSON results. Failed commands leave the current version unchanged.

const fs = require('node:fs');
const { runSpec } = require('./run');

function readInput() {
  const arg = process.argv[2];
  if (arg && arg !== '-') return fs.readFileSync(arg, 'utf8');
  return fs.readFileSync(0, 'utf8');
}

function main() {
  let spec;
  try {
    spec = JSON.parse(readInput());
  } catch (err) {
    console.error(JSON.stringify({ ok: false, error: { code: 'BAD_INPUT', message: err.message } }));
    process.exitCode = 2;
    return;
  }

  let out;
  try {
    out = runSpec(spec);
  } catch (err) {
    console.error(JSON.stringify({ ok: false, error: { code: 'BAD_VARIABLES', message: err.message } }));
    process.exitCode = 2;
    return;
  }
  console.log(JSON.stringify(out, null, 2));
}

main();
