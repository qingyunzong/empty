'use strict';

const fs = require('fs');
const { parseLog, verifyEvents } = require('./chain');

// Inspects the persistence state of a patch operation and classifies it:
//   OLD   - no final outputs exist; the old log is still authoritative.
//   NEW   - both final outputs exist and the cert matches the new log.
//   MIXED - partial commit; manual rollback is required (never silently mix).
function recoverState(outPath, certPath) {
  const outExists = fs.existsSync(outPath);
  const certExists = fs.existsSync(certPath);
  const tmps = [outPath + '.tmp', certPath + '.tmp'].filter((p) => fs.existsSync(p));

  if (!outExists && !certExists) {
    return { state: 'OLD', tmps };
  }
  if (outExists && certExists) {
    try {
      const events = parseLog(fs.readFileSync(outPath, 'utf8'));
      const root = verifyEvents(events);
      const cert = JSON.parse(fs.readFileSync(certPath, 'utf8'));
      if (cert && cert.newRoot === root) {
        return { state: 'NEW', tmps };
      }
      return { state: 'MIXED', reason: 'cert newRoot does not match new log root', tmps };
    } catch (err) {
      return { state: 'MIXED', reason: `final outputs failed validation: ${err.message}`, tmps };
    }
  }
  const missing = outExists ? certPath : outPath;
  return { state: 'MIXED', reason: `partial commit: ${missing} is missing`, tmps };
}

module.exports = { recoverState };
