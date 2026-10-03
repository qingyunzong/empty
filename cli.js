#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { mergeRecords } = require('./src/merge');

function usage() {
  console.error('usage: node cli.js <base.json> <left.json> <right.json> [outdir]');
  console.error('  base.json  : { "value": ..., "quality": ..., "reviewed": ... }');
  console.error('  left/right : { "edits": [ { "author", "level", "clock", "field", "old", "new" } ] }');
  process.exit(64);
}

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (err) {
    console.error(`error: cannot read ${file}: ${err.message}`);
    process.exit(65);
  }
}

function main(argv) {
  if (argv.length < 3 || argv.length > 4) usage();
  const [baseFile, leftFile, rightFile] = argv;
  const outdir = argv[3] || '.';

  const base = readJson(baseFile);
  const leftDoc = readJson(leftFile);
  const rightDoc = readJson(rightFile);
  const leftEdits = Array.isArray(leftDoc) ? leftDoc : leftDoc.edits || [];
  const rightEdits = Array.isArray(rightDoc) ? rightDoc : rightDoc.edits || [];

  const { merged, decisions, conflicts } = mergeRecords(base, leftEdits, rightEdits);

  fs.mkdirSync(outdir, { recursive: true });
  const write = (name, data) =>
    fs.writeFileSync(path.join(outdir, name), JSON.stringify(data, null, 2) + '\n');

  write('decision-log.json', {
    base,
    decisions,
    conflictCount: conflicts.length,
  });

  if (conflicts.length > 0) {
    write('conflicts.json', { certificates: conflicts });
    for (const cert of conflicts) {
      console.error(`conflict: field=${cert.field} reason=${cert.reason} certificate=${cert.certificateId}`);
    }
    process.exit(2);
  }

  write('merged.json', merged);
  console.log(`merged: ${path.join(outdir, 'merged.json')}`);
  process.exit(0);
}

main(process.argv.slice(2));
