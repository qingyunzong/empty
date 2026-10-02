#!/usr/bin/env node
'use strict';

const fs = require('fs');
const { Engine } = require('./src/engine');
const { ProtocolError } = require('./src/frame');
const { BusinessError } = require('./src/ledger');

// Runs a JSONL command file, returns { exitCode, out } without touching
// stdio so tests can drive it in-process.
function run(file) {
  if (!file) return { exitCode: 2, out: { code: 'BAD_INPUT', error: 'usage: node cli.js <in.jsonl>' } };

  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch (e) {
    return { exitCode: 2, out: { code: 'BAD_INPUT', error: `cannot read ${file}: ${e.message}` } };
  }

  const engine = new Engine();
  try {
    text.split(/\r?\n/).forEach((raw, idx) => {
      const s = raw.trim();
      if (!s || s.startsWith('#')) return;
      let cmd;
      try {
        cmd = JSON.parse(s);
      } catch {
        throw new ProtocolError(`line ${idx + 1}: invalid JSON`, 'BAD_INPUT');
      }
      engine.exec(cmd);
    });
  } catch (e) {
    if (e instanceof ProtocolError) return { exitCode: 2, out: { code: e.code || 'PROTOCOL_ERROR', error: e.message } };
    if (e instanceof BusinessError) return { exitCode: 3, out: { code: e.code || 'BUSINESS_REJECTED', error: e.message } };
    throw e;
  }

  return { exitCode: 0, out: engine.output() };
}

function main() {
  const { exitCode, out } = run(process.argv[2]);
  process.stdout.write(JSON.stringify(out, null, exitCode === 0 ? 2 : 0) + '\n');
  process.exit(exitCode);
}

if (require.main === module) main();

module.exports = { run };
