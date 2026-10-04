#!/usr/bin/env node
'use strict';
// Reads unsigned frames (one JSON object per line, without crc) from a file
// and prints the same frames as signed JSONL (crc added).
const fs = require('node:fs');
const { sign } = require('../src/frames');

const file = process.argv[2];
if (!file) {
  console.error('usage: node tools/sign.js <frames.jsonl>');
  process.exit(2);
}
const out = [];
for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
  const t = line.trim();
  if (!t) continue;
  out.push(JSON.stringify(sign(JSON.parse(t))));
}
process.stdout.write(out.join('\n') + '\n');
