'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { SettleError } = require('./engine');
const { sha256hex } = require('./cert');

const INPUT_FILES = ['accounts.jsonl', 'trades.jsonl', 'events.jsonl'];

function readJsonl(filePath) {
  let text;
  try {
    text = fs.readFileSync(filePath, 'utf8');
  } catch (err) {
    if (err.code === 'ENOENT') return { rows: [], digest: sha256hex('') };
    throw new SettleError('E_IO', `cannot read ${filePath}: ${err.message}`);
  }
  const digest = sha256hex(text);
  const rows = [];
  const lines = text.split(/\r?\n/);
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i].trim();
    if (line === '') continue;
    try {
      rows.push(JSON.parse(line));
    } catch {
      throw new SettleError('E_BAD_JSON', `${path.basename(filePath)}:${i + 1}: invalid JSON`);
    }
  }
  return { rows, digest };
}

function loadInputs(dir) {
  const out = { digests: {} };
  for (const name of INPUT_FILES) {
    const { rows, digest } = readJsonl(path.join(dir, name));
    out.digests[name] = digest;
    out[name.replace('.jsonl', '')] = rows;
  }
  return out; // { accounts, trades, events, digests }
}

module.exports = { readJsonl, loadInputs, INPUT_FILES };
