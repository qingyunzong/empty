#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const { validateInput } = require('./lib/validate');
const { buildPlan } = require('./lib/plan');

function main(argv, io) {
  const out = io || { stderr: (m) => process.stderr.write(m), writeFile: fs.writeFileSync, readFile: fs.readFileSync };
  const [command, inputPath, outputPath] = argv;
  if (command !== 'retry' || !inputPath || !outputPath || argv.length !== 3) {
    out.stderr('usage: node . retry <input.json> <output.json>\n');
    return 1;
  }
  let raw;
  try {
    raw = out.readFile(inputPath, 'utf8');
  } catch (err) {
    out.stderr(`error: cannot read input: ${err.message}\n`);
    return 1;
  }
  let data;
  try {
    data = JSON.parse(raw);
  } catch (err) {
    out.stderr(`error: invalid JSON: ${err.message}\n`);
    return 1;
  }
  const validation = validateInput(data);
  if (!validation.ok) {
    out.stderr(`error: ${validation.error}\n`);
    return 1;
  }
  const result = buildPlan(data);
  try {
    out.writeFile(outputPath, JSON.stringify(result, null, 2) + '\n');
  } catch (err) {
    out.stderr(`error: cannot write output: ${err.message}\n`);
    return 1;
  }
  return 0;
}

if (require.main === module) {
  process.exitCode = main(process.argv.slice(2));
}

module.exports = { main };
