#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { CorrectionLog, CorrectionError } = require('./src/correction-log');

function usage() {
  process.stderr.write('usage: node cli.js <observations.json> <corrections.json> [outDir]\n');
}

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (err) {
    throw new CorrectionError('INVALID_INPUT', `cannot read/parse ${file}: ${err.message}`);
  }
}

function main(argv) {
  const [obsPath, corrPath, outDir = '.'] = argv;
  if (!obsPath || !corrPath) {
    usage();
    return 1;
  }
  try {
    const observations = readJson(obsPath);
    const corrections = readJson(corrPath);
    if (!Array.isArray(corrections)) {
      throw new CorrectionError('INVALID_INPUT', 'corrections.json must be an array');
    }
    const log = new CorrectionLog(observations);
    for (const correction of corrections) {
      log.apply(correction);
    }
    fs.mkdirSync(outDir, { recursive: true });
    const state = { observations: log.getState(), stateHash: log.stateHash() };
    const history = { ...log.getHistory(), auditMap: log.auditMap() };
    fs.writeFileSync(path.join(outDir, 'state.json'), JSON.stringify(state, null, 2) + '\n');
    fs.writeFileSync(path.join(outDir, 'history.json'), JSON.stringify(history, null, 2) + '\n');
    process.stdout.write(`wrote ${path.join(outDir, 'state.json')} and ${path.join(outDir, 'history.json')}\n`);
    return 0;
  } catch (err) {
    if (err instanceof CorrectionError) {
      process.stderr.write(`error [${err.code}]: ${err.message}\n`);
    } else {
      process.stderr.write(`error: ${err.message}\n`);
    }
    return 1;
  }
}

if (require.main === module) {
  process.exit(main(process.argv.slice(2)));
}

module.exports = { main };
