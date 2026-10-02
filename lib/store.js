'use strict';
const fs = require('node:fs');
const { readJsonSync, writeJsonSync } = require('./util');

function freshDb() {
  return { version: 1, events: {}, state: { balances: {}, conflicts: [], applied: 0, undone: [] }, meta: { committedBatches: 0 } };
}

function loadDb(dbPath) {
  if (!fs.existsSync(dbPath)) return freshDb();
  return readJsonSync(dbPath);
}

function writeDb(dbPath, db) {
  writeJsonSync(dbPath, db);
}

module.exports = { freshDb, loadDb, writeDb };
