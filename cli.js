#!/usr/bin/env node
'use strict';

const fs = require('fs');
const { parseSpec, search } = require('./lib');

function main(argv, io) {
  const out = io && io.stdout ? io.stdout : (line) => console.log(line);
  const err = io && io.stderr ? io.stderr : (line) => console.error(line);
  const args = argv.slice(2);
  if (args.length !== 2) {
    err('usage: node cli.js <spec.json> <out.json>');
    return 2;
  }
  const [specPath, outPath] = args;
  let text;
  try {
    text = fs.readFileSync(specPath, 'utf8');
  } catch (readErr) {
    err(`E_PARSE: cannot read spec file ${specPath}: ${readErr.message}`);
    return 1;
  }
  let raw;
  try {
    raw = JSON.parse(text);
  } catch (parseErr) {
    err(`E_PARSE: invalid JSON in ${specPath}: ${parseErr.message}`);
    return 1;
  }
  let spec;
  try {
    spec = parseSpec(raw);
  } catch (specErr) {
    if (specErr && specErr.code === 'E_PARSE') {
      err(`E_PARSE: ${specErr.message}`);
      return 1;
    }
    throw specErr;
  }
  const result = search(spec);
  fs.writeFileSync(outPath, `${JSON.stringify(result, null, 2)}\n`);
  if (result.result === 'counterexample') {
    out(`counterexample (length ${result.length}): ${result.canonical.join(' ; ')}`);
  } else {
    out(
      `no counterexample up to length ${result.bound}; ` +
      `coverage ${result.coverage.combinations} combinations; certificate ${result.certificate}`
    );
  }
  return 0;
}

if (require.main === module) {
  process.exitCode = main(process.argv);
}

module.exports = { main };
