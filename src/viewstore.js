'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { GateError, EXIT_HASH_INPUT_MISSING } = require('./policy');
const { viewInputs, viewHash } = require('./hash');

function sanitize(name) {
  return String(name).replace(/[^A-Za-z0-9._-]/g, '_');
}

// Write a view file. If a current file exists with a different hash, the old
// file is preserved with its hash and marked expired; the new view replaces it.
function writeView(outDir, viewObj) {
  fs.mkdirSync(outDir, { recursive: true });
  const inputs = viewInputs(viewObj.view, viewObj.report, viewObj.fields);
  const hash = viewHash(inputs);
  const base = `${sanitize(viewObj.view)}.${sanitize(viewObj.report)}`;
  const currentPath = path.join(outDir, `${base}.json`);
  const expired = [];
  if (fs.existsSync(currentPath)) {
    const existing = JSON.parse(fs.readFileSync(currentPath, 'utf8'));
    if (!existing.hash || !existing.inputs) {
      throw new GateError(
        `existing view ${base}.json is missing hash inputs`,
        EXIT_HASH_INPUT_MISSING
      );
    }
    if (existing.hash !== hash) {
      const expiredName = `${base}.expired.${String(existing.hash).slice(0, 12)}.json`;
      fs.writeFileSync(
        path.join(outDir, expiredName),
        JSON.stringify({ ...existing, status: 'expired', supersededBy: hash }, null, 2) + '\n'
      );
      expired.push(expiredName);
    }
  }
  const doc = {
    view: viewObj.view,
    report: viewObj.report,
    status: 'current',
    inputs,
    hash,
  };
  fs.writeFileSync(currentPath, JSON.stringify(doc, null, 2) + '\n');
  return { file: `${base}.json`, hash, expired };
}

function verifyViewFile(filePath) {
  const doc = JSON.parse(fs.readFileSync(filePath, 'utf8'));
  const inputs = doc.inputs;
  if (
    !inputs ||
    typeof inputs !== 'object' ||
    inputs.view === undefined ||
    inputs.report === undefined ||
    inputs.fields === undefined
  ) {
    throw new GateError(
      `view ${path.basename(filePath)} is missing hash inputs`,
      EXIT_HASH_INPUT_MISSING
    );
  }
  const expected = viewHash(inputs);
  return {
    file: path.basename(filePath),
    status: doc.status || 'current',
    ok: expected === doc.hash,
    expected,
    actual: doc.hash,
  };
}

function verifyViewsDir(dir) {
  const files = fs
    .readdirSync(dir)
    .filter((f) => f.endsWith('.json'))
    .sort();
  return files.map((f) => verifyViewFile(path.join(dir, f)));
}

module.exports = { writeView, verifyViewFile, verifyViewsDir };
