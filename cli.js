#!/usr/bin/env node
'use strict';

const fs = require('fs');
const { Receiver } = require('./src/protocol');
const { validateEvent } = require('./src/event');
const { Ledger } = require('./src/ledger');
const { CodedError, FrameError } = require('./src/errors');

const USAGE = 'usage: node cli.js <frames.hex> --export <pkg.json>';

function stderr(msg) {
  fs.writeSync(2, msg);
}

function parseArgs(argv) {
  let input = null;
  let exportPath = null;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--export') {
      exportPath = argv[++i];
      if (!exportPath) throw new FrameError('--export requires a path');
    } else if (arg.startsWith('--')) {
      throw new FrameError(`unknown option ${arg}`);
    } else if (input === null) {
      input = arg;
    } else {
      throw new FrameError(`unexpected argument ${arg}`);
    }
  }
  if (!input) throw new FrameError('missing input frames file');
  if (!exportPath) throw new FrameError('missing --export <pkg.json>');
  return { input, exportPath };
}

function decodeHexLine(line, lineno) {
  if (!/^[0-9a-fA-F]*$/.test(line) || line.length % 2 !== 0) {
    throw new FrameError(`line ${lineno}: invalid hex frame`);
  }
  return Buffer.from(line, 'hex');
}

function run(argv) {
  const { input, exportPath } = parseArgs(argv);
  const text = fs.readFileSync(input, 'utf8');

  const receiver = new Receiver();
  const ledger = new Ledger();
  let frameCount = 0;
  let msgCount = 0;

  const lines = text.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (line === '' || line.startsWith('#')) continue;
    frameCount++;
    const frame = decodeHexLine(line, i + 1);
    for (const message of receiver.feed(frame)) {
      msgCount++;
      let parsed;
      try {
        parsed = JSON.parse(message);
      } catch (err) {
        throw new FrameError(`message ${msgCount}: invalid JSON: ${err.message}`);
      }
      ledger.ingest(validateEvent(parsed));
    }
  }

  const pkg = ledger.exportPackage(); // strict finalize: exit 9 / 10 surface here
  fs.writeFileSync(exportPath, JSON.stringify(pkg, null, 2) + '\n');
  stderr(
    `ok: ${frameCount} frames, ${msgCount} messages, ${pkg.eventCount} events, ` +
    `${pkg.itemCount} items, hash=${pkg.contentHash}\n`
  );
  return 0;
}

try {
  process.exitCode = run(process.argv.slice(2));
} catch (err) {
  if (err instanceof CodedError) {
    stderr(`error(exit ${err.exitCode}): ${err.message}\n`);
    process.exitCode = err.exitCode;
  } else if (err && err.code === 'ENOENT') {
    stderr(`error(exit 2): ${err.message}\n`);
    process.exitCode = 2;
  } else {
    stderr(`error(exit 1): ${err && err.stack ? err.stack : err}\n`);
    process.exitCode = 1;
  }
}
