'use strict';

const fs = require('node:fs');
const path = require('node:path');

function readJsonl(file) {
  if (!fs.existsSync(file)) return [];
  return fs
    .readFileSync(file, 'utf8')
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line));
}

function readInputs(dir) {
  const lotsFile = path.join(dir, 'lots.json');
  if (!fs.existsSync(lotsFile)) throw new Error(`missing required input: ${lotsFile}`);
  const lots = JSON.parse(fs.readFileSync(lotsFile, 'utf8'));
  if (!Array.isArray(lots)) throw new Error('lots.json must contain a JSON array');
  return {
    lots,
    edges: readJsonl(path.join(dir, 'edges.jsonl')),
    tests: readJsonl(path.join(dir, 'tests.jsonl')),
    corrections: readJsonl(path.join(dir, 'corrections.jsonl')),
  };
}

module.exports = { readInputs, readJsonl };
