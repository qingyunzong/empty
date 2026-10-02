'use strict';
const fs = require('node:fs');
const { sha256, LedgerError } = require('./util');

function validateRow(row, line) {
  const bad = (msg) => {
    throw new LedgerError('bad-row', 'journal line ' + line + ': ' + msg, { line });
  };
  if (!row || typeof row !== 'object' || Array.isArray(row)) bad('row must be an object');
  if (typeof row.id !== 'string' || row.id.length === 0) bad('row.id must be a non-empty string');
  if (row.undo !== undefined) {
    if (typeof row.undo !== 'string' || row.undo.length === 0) bad('row.undo must be a non-empty string');
    return;
  }
  if (typeof row.account !== 'string' || row.account.length === 0) bad('row.account must be a non-empty string');
  if (!Number.isInteger(row.amount_cents)) bad('row.amount_cents must be an integer number of cents');
  if (row.amount_cents < 0) bad('row.amount_cents must be >= 0');
}

function readJournal(file) {
  if (!fs.existsSync(file)) {
    throw new LedgerError('missing-journal', 'journal not found: ' + file, { file });
  }
  const raw = fs.readFileSync(file, 'utf8');
  const parts = raw.split('\n');
  if (parts.length && parts[parts.length - 1] === '') parts.pop();
  return parts.map((text, i) => {
    let row;
    try {
      row = JSON.parse(text);
    } catch {
      throw new LedgerError('bad-json', 'journal line ' + (i + 1) + ' is not valid JSON', { line: i + 1 });
    }
    validateRow(row, i + 1);
    return { line: i + 1, raw: text, hash: sha256(text), row };
  });
}

module.exports = { readJournal, validateRow };
