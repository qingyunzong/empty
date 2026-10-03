#!/usr/bin/env node
'use strict';

const fs = require('fs');
const { diffBooks, verifyCertificate, ReconError } = require('./index');

function readJsonl(path) {
  const text = fs.readFileSync(path, 'utf8');
  const events = [];
  text.split(/\r?\n/).forEach((line, i) => {
    const trimmed = line.trim();
    if (trimmed === '') return;
    try {
      events.push(JSON.parse(trimmed));
    } catch (err) {
      throw new ReconError('BAD_JSONL', `${path}:${i + 1}: ${err.message}`);
    }
  });
  return events;
}

function usage() {
  console.error('usage:');
  console.error('  node cli.js diff   left.jsonl right.jsonl [--k 5]');
  console.error('  node cli.js verify left.jsonl right.jsonl certificate.json');
  process.exit(2);
}

function main(argv) {
  const [cmd, ...rest] = argv;
  if (cmd === 'diff') {
    const [leftPath, rightPath, ...flags] = rest;
    if (!leftPath || !rightPath) usage();
    let k = 5;
    for (let i = 0; i < flags.length; i += 1) {
      const flag = flags[i];
      if (flag === '--k') {
        k = Number.parseInt(flags[i + 1], 10);
        i += 1;
      } else if (flag.startsWith('--k=')) {
        k = Number.parseInt(flag.slice(4), 10);
      } else {
        usage();
      }
    }
    if (!Number.isInteger(k) || k < 0) {
      throw new ReconError('BAD_ARGS', `--k must be a non-negative integer, got ${k}`);
    }
    const result = diffBooks(readJsonl(leftPath), readJsonl(rightPath), { k });
    console.log(JSON.stringify(result, null, 2));
    process.exitCode = result.balanced ? 0 : 1;
    return;
  }
  if (cmd === 'verify') {
    const [leftPath, rightPath, certPath] = rest;
    if (!leftPath || !rightPath || !certPath) usage();
    const cert = JSON.parse(fs.readFileSync(certPath, 'utf8'));
    verifyCertificate(readJsonl(leftPath), readJsonl(rightPath), cert);
    console.log(JSON.stringify({ valid: true }));
    return;
  }
  usage();
}

try {
  main(process.argv.slice(2));
} catch (err) {
  const code = err instanceof ReconError ? err.code : 'INTERNAL';
  console.error(JSON.stringify({ error: { code, message: err.message } }, null, 2));
  process.exitCode = code === 'CERT_INVALID' ? 3 : 2;
}
