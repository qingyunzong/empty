#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const { buildReport, verifyReport, ReportError } = require('./lib');

function readJson(path) {
  try {
    return JSON.parse(fs.readFileSync(path, 'utf8'));
  } catch (err) {
    throw new ReportError('E_INPUT', `cannot read JSON ${path}: ${err.message}`);
  }
}

function main(argv) {
  const [cmd, input, output] = argv;
  if (cmd === 'build') {
    if (!input || !output) {
      throw new ReportError('E_INPUT', 'usage: node cli.js build spec.json report.json');
    }
    const report = buildReport(readJson(input));
    fs.writeFileSync(output, JSON.stringify(report, null, 2) + '\n');
    process.stdout.write(
      `built ${output} closure=${report.proof.closure.length} hash=${report.proof.canonicalHash}\n`);
    return;
  }
  if (cmd === 'verify') {
    if (!input) throw new ReportError('E_INPUT', 'usage: node cli.js verify report.json');
    const result = verifyReport(readJson(input));
    process.stdout.write(`verify ok closure=${result.closure.length} hash=${result.canonicalHash}\n`);
    return;
  }
  throw new ReportError('E_INPUT', 'usage: node cli.js <build spec.json report.json | verify report.json>');
}

try {
  main(process.argv.slice(2));
} catch (err) {
  const code = err && err.code ? err.code : 'E_INPUT';
  process.stderr.write(`${code}: ${err.message}\n`);
  if (err.details && err.details.minimal) {
    process.stderr.write(`minimal over-privilege set: ${err.details.minimal.join(', ')}\n`);
  }
  process.exit(1);
}
