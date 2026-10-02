#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const { FrameDecoder } = require('./src/frame');
const { Engine } = require('./src/engine');
const { PacklineError, EXIT, frameError } = require('./src/errors');

const CHUNK_SIZE = 64; // feed the decoder in small chunks; it is fragmentation-safe

function usage() {
  console.error('usage: node cli.js <frames.hex> [--export <pkg.json>]');
  console.error('  frames.hex  hex-encoded frame stream (whitespace tolerated)');
  console.error('  --export    write the traceability package JSON to this path (default: stdout)');
  console.error('exit codes: 0 ok | 1 usage/io | 2 frame error | 9 unknown ref | 10 SCRAP terminal violation');
}

function main(argv) {
  const args = argv.slice(2);
  let input = null;
  let exportPath = null;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--export') {
      exportPath = args[++i];
      if (!exportPath) throw new PacklineError('--export requires a path', EXIT.GENERAL);
    } else if (arg === '--help' || arg === '-h') {
      usage();
      return EXIT.OK;
    } else if (arg.startsWith('-')) {
      throw new PacklineError('unknown option: ' + arg, EXIT.GENERAL);
    } else if (input === null) {
      input = arg;
    } else {
      throw new PacklineError('unexpected argument: ' + arg, EXIT.GENERAL);
    }
  }
  if (input === null) {
    usage();
    return EXIT.GENERAL;
  }

  const raw = fs.readFileSync(input, 'utf8');
  const hex = raw.replace(/\s+/g, '');
  if (hex.length % 2 !== 0 || /[^0-9a-fA-F]/.test(hex)) {
    throw frameError('input is not valid hex');
  }
  const bytes = Buffer.from(hex, 'hex');

  const decoder = new FrameDecoder();
  const engine = new Engine();
  let applied = 0;
  let duplicates = 0;
  for (let off = 0; off < bytes.length; off += CHUNK_SIZE) {
    const events = decoder.push(bytes.subarray(off, Math.min(off + CHUNK_SIZE, bytes.length)));
    for (const event of events) {
      if (engine.apply(event) === 'duplicate') duplicates++;
      else applied++;
    }
  }
  decoder.end();
  engine.finalize();

  const pkg = engine.exportPackage();
  const json = JSON.stringify(pkg, null, 2) + '\n';
  if (exportPath) fs.writeFileSync(exportPath, json);
  else process.stdout.write(json);

  console.error(
    'events: ' + applied + ' applied, ' + duplicates + ' duplicate(s); ' +
    'items: ' + Object.keys(pkg.items).length + '; ' +
    'contentHash: ' + pkg.contentHash
  );
  if (exportPath) console.error('exported: ' + exportPath);
  return EXIT.OK;
}

try {
  process.exit(main(process.argv));
} catch (err) {
  if (err instanceof PacklineError) {
    console.error('error(exit ' + err.exitCode + '): ' + err.message);
    process.exit(err.exitCode);
  }
  console.error('error: ' + (err && err.message ? err.message : err));
  process.exit(EXIT.GENERAL);
}
