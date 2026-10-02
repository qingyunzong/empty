'use strict';

const fs = require('node:fs');
const path = require('node:path');

const EMPTY_STATE = () => ({
  batches: [],       // {batchId, layer, parentId, customerId, amount(cents), currency, date, status, bankConfirmed}
  adjustments: [],   // {id, type:'reversal', ofBatchId, customerId, amount, currency, date, createdAt}
  budgets: {},       // "customer|date" -> net cents
  limits: {},        // "customer|date" -> limit cents
  journal: null,     // {opId, phase:'budget_applied'|'done'}
});

function loadState(file) {
  if (!file || !fs.existsSync(file)) return EMPTY_STATE();
  const state = JSON.parse(fs.readFileSync(file, 'utf8'));
  return Object.assign(EMPTY_STATE(), state);
}

function saveState(file, state) {
  if (!file) return;
  const tmp = file + '.tmp';
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(tmp, JSON.stringify(state, null, 2));
  fs.renameSync(tmp, file); // atomic replace
}

module.exports = { EMPTY_STATE, loadState, saveState };
