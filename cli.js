#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const { Engine } = require('./src/engine');
const { Chain, ChainError, EXIT } = require('./src/chain');
const { FrameParser, FrameError } = require('./src/frame');

class CliError extends Error {
  constructor(message, code) {
    super(message);
    this.exitCode = code;
  }
}

function cmdRun(framesFile, dataDir, out) {
  let bytes;
  try {
    bytes = fs.readFileSync(framesFile);
  } catch {
    throw new CliError(`cannot read frames file: ${framesFile}`, EXIT.FRAME);
  }
  const engine = new Engine(dataDir);
  const parser = new FrameParser();
  // Feed in 7-byte chunks to exercise fragmented-frame handling.
  for (let i = 0; i < bytes.length; i += 7) {
    for (const { frame, raw } of parser.push(bytes.subarray(i, i + 7))) {
      for (const r of engine.process(frame, raw)) out(JSON.stringify(r));
    }
  }
  if (parser.pendingBytes !== 0) throw new FrameError(`truncated frame: ${parser.pendingBytes} leftover bytes`);
  const summary = engine.finalize();
  for (const p of summary.pending) out(JSON.stringify(p));
  out(JSON.stringify({
    root: summary.root, count: summary.count,
    rejected: summary.rejections.length, checkpoint: summary.checkpoint,
  }));
  return summary.exitCode;
}

function cmdVerify(checkpointFile, dataDir, out) {
  let ck;
  try {
    ck = JSON.parse(fs.readFileSync(checkpointFile, 'utf8'));
  } catch {
    throw new CliError(`cannot read checkpoint: ${checkpointFile}`, EXIT.FRAME);
  }
  const chain = new Chain(dataDir);
  chain.verifyCheckpoint(ck);
  out(JSON.stringify({ ok: true, count: chain.count, root: chain.tip }));
  return EXIT.OK;
}

// argv: [cmd, arg?]; io: { out(line), err(line), dataDir }
function run(argv, io = {}) {
  const out = io.out || ((l) => process.stdout.write(l + '\n'));
  const err = io.err || ((l) => process.stderr.write(l + '\n'));
  const dataDir = io.dataDir || process.env.AUDIT_DIR || path.join(process.cwd(), 'audit-data');
  const [cmd, arg] = argv;
  try {
    if (cmd === 'verify') {
      if (!arg) throw new CliError('usage: node cli.js verify <checkpoint.json>', EXIT.FRAME);
      return cmdVerify(arg, dataDir, out);
    }
    if (cmd) return cmdRun(cmd, dataDir, out);
    err('usage:\n  node cli.js <frames.bin>\n  node cli.js verify <checkpoint.json>');
    return 64;
  } catch (e) {
    if (e instanceof CliError || e instanceof FrameError || e instanceof ChainError) {
      err(`error: ${e.message}`);
      if (e instanceof CliError) return e.exitCode;
      return e instanceof FrameError ? EXIT.FRAME : EXIT.CHAIN;
    }
    throw e;
  }
}

if (require.main === module) {
  process.exitCode = run(process.argv.slice(2));
}

module.exports = { run };
