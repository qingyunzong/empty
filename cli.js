#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const { createHistory, query, HistError } = require('./lib');

const USAGE = 'usage: node cli.js <hist.jsonl> --as-of <ts>:<seq> [--branch <name>]';

function main(argv, io) {
  const out = io && io.stdout ? io.stdout : (s) => console.log(s);
  const err = io && io.stderr ? io.stderr : (s) => console.error(s);
  const args = argv.slice(2);
  let file = null;
  let asOf = null;
  let branch = 'main';
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--as-of') {
      asOf = args[++i];
    } else if (a === '--branch') {
      branch = args[++i];
    } else if (a === '--help' || a === '-h') {
      out(USAGE);
      return 0;
    } else if (file === null && !a.startsWith('-')) {
      file = a;
    } else {
      err(`unknown argument: ${a}`);
      err(USAGE);
      return 2;
    }
  }
  if (file === null || asOf === null || asOf === undefined) {
    err(USAGE);
    return 2;
  }
  const m = /^(\d+):(\d+)$/.exec(asOf);
  if (!m) {
    err(`invalid --as-of ${JSON.stringify(asOf)}, expected <ts>:<seq>`);
    return 2;
  }
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch (e) {
    err(`E_IO: cannot read ${file}: ${e.message}`);
    return 1;
  }
  try {
    const history = createHistory(text);
    const result = query(history, { branch, ts: Number(m[1]), seq: Number(m[2]) });
    out(JSON.stringify(result, null, 2));
    return 0;
  } catch (e) {
    if (e instanceof HistError) {
      err(`${e.code}: ${e.message}`);
      return 1;
    }
    throw e;
  }
}

if (require.main === module) {
  process.exitCode = main(process.argv);
}

module.exports = { main };
