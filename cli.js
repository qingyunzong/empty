#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const { FrameParser } = require('./src/frame');
const { Engine } = require('./src/engine');

const CHUNK = 7;

function run(data, { key = 'dev-key', ttl = 100, defaultLimit = 100000 } = {}) {
  const parser = new FrameParser(key);
  const engine = new Engine({ ttl, defaultLimit });
  let exitCode = 0;
  let stderr = '';
  try {
    for (let off = 0; off < data.length; off += CHUNK) {
      const messages = parser.push(data.subarray(off, off + CHUNK));
      for (const msg of messages) engine.ingest(msg);
    }
    parser.end();
  } catch (err) {
    exitCode = err.exitCode || 1;
    stderr = JSON.stringify({ error: err.message, code: err.code || 'ERROR', exitCode }) + '\n';
  }
  const stdout = JSON.stringify(engine.report(), null, 2) + '\n';
  return { exitCode, stdout, stderr };
}

function main() {
  const file = process.argv[2];
  if (!file) {
    process.stderr.write('usage: node cli.js <frames.bin>\n');
    process.exit(64);
  }
  const { exitCode, stdout, stderr } = run(fs.readFileSync(file), {
    key: process.env.PA_KEY || 'dev-key',
    ttl: process.env.PA_TTL !== undefined ? Number(process.env.PA_TTL) : 100,
    defaultLimit: process.env.PA_LIMIT !== undefined ? Number(process.env.PA_LIMIT) : 100000,
  });
  if (stderr) process.stderr.write(stderr);
  process.stdout.write(stdout);
  process.exit(exitCode);
}

if (require.main === module) main();

module.exports = { run };
