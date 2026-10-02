#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { parseArgs } = require('node:util');
const { readInputs } = require('./lib/io');
const { validate } = require('./lib/validate');
const { Engine } = require('./lib/engine');

function main(argv) {
  let parsed;
  try {
    parsed = parseArgs({
      args: argv,
      allowPositionals: true,
      options: { in: { type: 'string' }, out: { type: 'string' } },
    });
  } catch (err) {
    console.error(err.message);
    return 1;
  }
  const [cmd] = parsed.positionals;
  const { in: inDir, out: outDir } = parsed.values;
  if (cmd !== 'trace' || !inDir || !outDir) {
    console.error('usage: node cli.js trace --in <dir> --out <dir>');
    return 1;
  }

  let input;
  try {
    input = readInputs(inDir);
  } catch (err) {
    console.error(`failed to read inputs: ${err.message}`);
    return 1;
  }

  fs.mkdirSync(outDir, { recursive: true });

  // Validate everything up front: on any error we write errors.jsonl and
  // refuse to emit trace.json / certificates.jsonl (no partial output).
  const { errors, lots, edges, tests } = validate(input);
  if (errors.length > 0) {
    fs.writeFileSync(path.join(outDir, 'errors.jsonl'), errors.map((e) => JSON.stringify(e)).join('\n') + '\n');
    return 2;
  }

  const engine = new Engine({ lots, edges, tests });
  engine.computeInitial();
  for (const corr of input.corrections) engine.applyCorrection(corr);

  const trace = { products: engine.products() };
  fs.writeFileSync(path.join(outDir, 'trace.json'), JSON.stringify(trace, null, 2) + '\n');
  fs.writeFileSync(
    path.join(outDir, 'certificates.jsonl'),
    engine.certLog.map((e) => JSON.stringify(e)).join('\n') + '\n'
  );
  return 0;
}

if (require.main === module) {
  process.exit(main(process.argv.slice(2)));
}

module.exports = { main };
