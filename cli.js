#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const { Engine, AuditError } = require('./lib/audit');

// Runs the audit session described by the JSONL file at inputPath.
// Returns the process exit code; output lines go to writeOut, errors to
// writeErr. Kept side-effect free (except the pack store file) so tests
// can drive it in-process.
function execute(inputPath, storePath, writeOut, writeErr) {
  let engine;
  try {
    engine = new Engine(storePath);
  } catch (err) {
    const code = err instanceof AuditError ? err.code : 'STORE_ERROR';
    writeErr(JSON.stringify({ error: err.message, code }));
    return 5;
  }

  const text = fs.readFileSync(inputPath, 'utf8');
  const lines = text.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (line === '') continue;
    let cmd;
    try {
      cmd = JSON.parse(line);
    } catch {
      writeErr(JSON.stringify({ error: `line ${i + 1}: invalid JSON`, code: 'BAD_JSON' }));
      return 5;
    }
    try {
      writeOut(JSON.stringify(engine.run(cmd)));
    } catch (err) {
      if (err instanceof AuditError) {
        writeErr(JSON.stringify({ error: err.message, code: err.code }));
        return err.exitCode;
      }
      throw err;
    }
  }
  return 0;
}

function main() {
  const inputPath = process.argv[2] || 'audit.jsonl';
  const storePath = process.env.AUDIT_STORE || 'packs.log';
  const code = execute(
    inputPath,
    storePath,
    (line) => process.stdout.write(line + '\n'),
    (line) => process.stderr.write(line + '\n'),
  );
  process.exit(code);
}

if (require.main === module) main();

module.exports = { execute };
