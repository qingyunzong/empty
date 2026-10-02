#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const { parseSpec } = require('./spec');
const { analyze } = require('./search');

function main(args) {
  if (args.length !== 2) {
    console.error('usage: node cli.js <spec.json> <out.json>');
    return 2;
  }
  const [specPath, outPath] = args;

  let text;
  try {
    text = fs.readFileSync(specPath, 'utf8');
  } catch (err) {
    console.error(`E_PARSE: cannot read spec file: ${err.message}`);
    return 1;
  }

  let json;
  try {
    json = JSON.parse(text);
  } catch (err) {
    console.error(`E_PARSE: invalid JSON: ${err.message}`);
    return 1;
  }

  let spec;
  try {
    spec = parseSpec(json);
  } catch (err) {
    if (err && err.code === 'E_PARSE') {
      console.error(`E_PARSE: ${err.message}`);
      return 1;
    }
    throw err;
  }

  const result = analyze(spec);

  try {
    fs.writeFileSync(outPath, JSON.stringify(result, null, 2) + '\n');
  } catch (err) {
    console.error(`E_WRITE: cannot write output file: ${err.message}`);
    return 1;
  }

  if (result.result === 'proof') {
    console.log(
      `proof: no counterexample within ${spec.maxLength} actions ` +
        `(certificate ${result.certificate.hash})`
    );
  } else {
    console.log(`counterexample: ${result.length} actions written to ${outPath}`);
  }
  return 0;
}

if (require.main === module) {
  process.exit(main(process.argv.slice(2)));
}

module.exports = { main };
