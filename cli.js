#!/usr/bin/env node
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { mergePaths } = require('./src/sync');
const { generatePair, toNdjson } = require('./src/generate');

function usage() {
  process.stderr.write(
    [
      'usage:',
      '  node cli.js merge <a.ndjson> <b.ndjson> --out <dir>',
      '  node cli.js gen <dir> [--count N] [--seed S]',
      '',
    ].join('\n')
  );
}

function main(argv) {
  const [cmd, ...rest] = argv;
  if (cmd === 'merge') {
    const files = [];
    let out = null;
    for (let i = 0; i < rest.length; i++) {
      if (rest[i] === '--out') out = rest[++i];
      else files.push(rest[i]);
    }
    if (files.length !== 2 || !out) {
      usage();
      process.exit(2);
    }
    const result = mergePaths(files[0], files[1], out);
    process.stdout.write(
      `merged ${result.log.length} events, balance=${result.balance}, conflicts=${result.conflicts.length} -> ${out}\n`
    );
    return;
  }
  if (cmd === 'gen') {
    const dir = rest[0];
    let count = 200;
    let seed = 'group17';
    for (let i = 1; i < rest.length; i++) {
      if (rest[i] === '--count') count = Number(rest[++i]);
      else if (rest[i] === '--seed') seed = String(rest[++i]);
    }
    if (!dir || !Number.isInteger(count) || count < 1) {
      usage();
      process.exit(2);
    }
    const { a, b } = generatePair(count, seed);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'a.ndjson'), toNdjson(a));
    fs.writeFileSync(path.join(dir, 'b.ndjson'), toNdjson(b));
    process.stdout.write(`generated ${count} events per node -> ${dir}\n`);
    return;
  }
  usage();
  process.exit(2);
}

try {
  main(process.argv.slice(2));
} catch (err) {
  process.stderr.write(`error: ${err.message}\n`);
  process.exit(typeof err.code === 'number' ? err.code : 1);
}
