#!/usr/bin/env node
'use strict';

const fs = require('fs');
const { run, InputError } = require('./lib/restate');

function main(argv) {
  const [cmd, inputPath, outputPath] = argv;
  if (cmd !== 'restate' || !inputPath || !outputPath) {
    console.error('用法: node . restate <input.json> <output.json>');
    return 1;
  }
  let raw;
  try {
    raw = JSON.parse(fs.readFileSync(inputPath, 'utf8'));
  } catch (e) {
    console.error(`无法读取输入: ${e.message}`);
    return 1;
  }
  let out;
  try {
    out = run(raw);
  } catch (e) {
    if (e instanceof InputError) {
      console.error(`输入非法: ${e.message}`);
      return 1;
    }
    throw e;
  }
  fs.writeFileSync(outputPath, `${JSON.stringify(out, null, 2)}\n`);
  console.log(
    `status=${out.status} period=${out.period ?? '-'} ` +
      `items=${out.items.join(',') || '-'} reversals=${out.reversals} ` +
      `nodes=${out.nodes}/${out.budget}`,
  );
  return 0;
}

if (require.main === module) {
  process.exitCode = main(process.argv.slice(2));
}

module.exports = { main };
