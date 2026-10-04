#!/usr/bin/env node
'use strict';
const fs = require('node:fs');
const { extractFrames, validateFrame } = require('./src/frames');
const engine = require('./src/engine');
const { ExitError } = require('./src/util');

// Pure entry point: input text -> { code, stdout, stderr }. Exported for tests.
function execute(text) {
  try {
    const raw = extractFrames(text);
    const frames = raw.map((f, i) => validateFrame(f, i));
    const result = engine.run(frames);
    return { code: 0, stdout: JSON.stringify(result, null, 2) + '\n', stderr: '' };
  } catch (e) {
    if (e instanceof ExitError) {
      return { code: e.code, stdout: '', stderr: JSON.stringify({ error: { code: e.code, message: e.message } }) + '\n' };
    }
    throw e;
  }
}

function main() {
  const file = process.argv[2];
  if (!file) {
    console.error('usage: node cli.js <in.jsonl>');
    process.exit(2);
  }
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch (e) {
    console.error(JSON.stringify({ error: { code: 2, message: `cannot read ${file}: ${e.message}` } }));
    process.exit(2);
  }
  const { code, stdout, stderr } = execute(text);
  if (stdout) process.stdout.write(stdout);
  if (stderr) process.stderr.write(stderr);
  process.exit(code);
}

if (require.main === module) main();
module.exports = { execute };
