#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const { scanDir } = require('./lib/manifest');
const { makeDelta } = require('./lib/delta');
const { applyDelta } = require('./lib/apply');
const { certify } = require('./lib/certify');
const { toErrorJSON, errPath } = require('./lib/errors');

function usage() {
  process.stderr.write(
    [
      'usage:',
      '  node cli.js scan <dir> [--out manifest.json]',
      '  node cli.js makeDelta <source> <target> [--out delta.json]',
      '  node cli.js applyDelta <delta.json> <targetDir>',
      '  node cli.js certify <targetDir> <delta.json|manifest.json|dir>',
      '',
      '<source>/<target> may be directories (scanned) or manifest JSON files.',
      'env DELTA_CHUNK_SIZE overrides the default 64KiB chunk size.',
      '',
    ].join('\n')
  );
  process.exit(2);
}

function parseArgs(args) {
  const positional = [];
  let out = null;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--out') {
      out = args[++i];
    } else {
      positional.push(args[i]);
    }
  }
  return { positional, out };
}

function emit(obj, out) {
  const text = JSON.stringify(obj, null, 2) + '\n';
  if (out) {
    fs.writeFileSync(out, text);
    process.stdout.write(JSON.stringify({ written: out }) + '\n');
  } else {
    process.stdout.write(text);
  }
}

function chunkSizeOpt() {
  const v = process.env.DELTA_CHUNK_SIZE;
  if (!v) return {};
  const n = Number(v);
  if (!Number.isInteger(n) || n <= 0) throw errPath('invalid DELTA_CHUNK_SIZE', { value: v });
  return { chunkSize: n };
}

function loadManifestOrScan(p) {
  if (fs.statSync(p).isDirectory()) return scanDir(p, chunkSizeOpt());
  return JSON.parse(fs.readFileSync(p, 'utf8'));
}

function dirReader(dir) {
  return (rel, offset, size) => {
    const fd = fs.openSync(path.join(dir, rel), 'r');
    try {
      const buf = Buffer.alloc(size);
      let read = 0;
      while (read < size) read += fs.readSync(fd, buf, read, size - read, offset + read);
      return buf;
    } finally {
      fs.closeSync(fd);
    }
  };
}

function main(argv) {
  const [cmd, ...rest] = argv;
  const { positional, out } = parseArgs(rest);

  switch (cmd) {
    case 'scan': {
      if (positional.length !== 1) usage();
      emit(scanDir(positional[0], chunkSizeOpt()), out);
      break;
    }
    case 'makeDelta': {
      if (positional.length !== 2) usage();
      const [src, tgt] = positional;
      const srcManifest = loadManifestOrScan(src);
      const tgtManifest = loadManifestOrScan(tgt);
      const reader = fs.statSync(tgt).isDirectory() ? dirReader(tgt) : null;
      emit(makeDelta(srcManifest, tgtManifest, reader), out);
      break;
    }
    case 'applyDelta': {
      if (positional.length !== 2) usage();
      const delta = JSON.parse(fs.readFileSync(positional[0], 'utf8'));
      emit(applyDelta(delta, positional[1]), out);
      break;
    }
    case 'certify': {
      if (positional.length < 1 || positional.length > 2) usage();
      const dir = positional[0];
      let expected = null;
      if (positional[1]) {
        const p = positional[1];
        expected = fs.statSync(p).isDirectory()
          ? scanDir(p, chunkSizeOpt())
          : JSON.parse(fs.readFileSync(p, 'utf8'));
      }
      emit(certify(dir, expected, chunkSizeOpt()), out);
      break;
    }
    default:
      usage();
  }
}

try {
  main(process.argv.slice(2));
} catch (e) {
  process.stderr.write(JSON.stringify(toErrorJSON(e)) + '\n');
  process.exit(1);
}
