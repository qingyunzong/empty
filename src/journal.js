'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { PatchError } = require('./ops');

const JOURNAL_FILE = 'journal.json';
const JOURNAL_TMP = 'journal.json.tmp';

function journalPath(pkgDir) {
  return path.join(pkgDir, JOURNAL_FILE);
}

function readJournal(pkgDir) {
  const file = journalPath(pkgDir);
  if (!fs.existsSync(file)) return null;
  let journal;
  try {
    journal = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (err) {
    throw new PatchError(`journal.json is corrupt: ${err.message}`);
  }
  if (
    journal === null || typeof journal !== 'object' ||
    (journal.status !== 'applying' && journal.status !== 'committed') ||
    !Number.isInteger(journal.appliedCount) ||
    !Array.isArray(journal.ops) ||
    !Array.isArray(journal.undo) ||
    !Number.isInteger(journal.baseVersion)
  ) {
    throw new PatchError('journal.json has an invalid shape');
  }
  return journal;
}

function writeJournal(pkgDir, journal) {
  const tmp = path.join(pkgDir, JOURNAL_TMP);
  const fd = fs.openSync(tmp, 'w');
  try {
    fs.writeSync(fd, JSON.stringify(journal, null, 2) + '\n');
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  fs.renameSync(tmp, journalPath(pkgDir));
}

function removeJournal(pkgDir) {
  try {
    fs.unlinkSync(journalPath(pkgDir));
  } catch (err) {
    if (err.code !== 'ENOENT') throw err;
  }
}

// Removes every leftover temporary artifact (*.tmp) from the package dir.
function cleanTemps(pkgDir) {
  for (const name of fs.readdirSync(pkgDir)) {
    if (name.endsWith('.tmp')) {
      fs.unlinkSync(path.join(pkgDir, name));
    }
  }
}

module.exports = { JOURNAL_FILE, readJournal, writeJournal, removeJournal, cleanTemps };
