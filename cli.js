#!/usr/bin/env node
'use strict';
const fs = require('node:fs');
const { FrameStream, FrameError } = require('./lib/frame');
const { Terminal } = require('./lib/terminal');
const { ChainError, verifyCheckpointFile } = require('./lib/log');

const EXIT_FRAME = 2;
const EXIT_LEASE = 3;
const EXIT_CHAIN = 5;
const EXIT_CRASH = 70;

// Note: normal exits use process.exitCode (never process.exit) so piped
// stdout/stderr is fully flushed. Crash injection uses process.exit on
// purpose: a real crash does not flush anything.

function cmdRun(framesPath) {
  const dir = process.env.AT_DIR || process.cwd();
  const crashAfter = process.env.AT_CRASH_AFTER || null;
  const crashAt = Number(process.env.AT_CRASH_AT || 1);
  let parsedCount = 0;
  let flushedCount = 0;
  let indexedCount = 0;
  const hooks = {
    afterFlush() {
      if (crashAfter === 'flush' && ++flushedCount >= crashAt) process.exit(EXIT_CRASH);
    },
    afterIndex() {
      if (crashAfter === 'index' && ++indexedCount >= crashAt) process.exit(EXIT_CRASH);
    },
  };

  let term;
  try {
    term = new Terminal(dir, {
      hooks,
      checkpointEvery: Number(process.env.AT_CHECKPOINT_EVERY || 4),
    });
  } catch (e) {
    if (e instanceof ChainError) {
      process.stderr.write(JSON.stringify({ error: 'chain_break', reason: e.reason, index: e.index }) + '\n');
      process.exitCode = EXIT_CHAIN;
      return;
    }
    throw e;
  }

  const stream = new FrameStream();
  const data = fs.readFileSync(framesPath);
  try {
    const CHUNK = 4096;
    for (let off = 0; off < data.length; off += CHUNK) {
      for (const { frame, raw } of stream.push(data.subarray(off, off + CHUNK))) {
        if (crashAfter === 'parse' && ++parsedCount >= crashAt) process.exit(EXIT_CRASH); // crash point 1
        for (const ev of term.submit(frame, raw)) console.log(JSON.stringify(ev));
      }
    }
    stream.end();
  } catch (e) {
    if (e instanceof FrameError) {
      process.stderr.write(JSON.stringify({ error: 'frame', reason: e.reason }) + '\n');
      process.exitCode = EXIT_FRAME;
      return;
    }
    throw e;
  }

  for (const p of term.pending) {
    console.log(JSON.stringify({ opId: p.frame.opId, actor: p.frame.actor, status: 'pending' }));
  }
  const cp = term.log.memory ? null : term.log.writeCheckpoint();
  console.log(JSON.stringify({
    root: term.log.root,
    count: term.log.entries.length,
    headHash: term.log.headHash,
    checkpoint: cp ? term.log.checkpointPath : null,
    leaseExpired: term.leaseExpired,
  }));
  if (term.leaseExpired > 0) process.exitCode = EXIT_LEASE;
}

function cmdVerify(checkpointPath) {
  let res;
  try {
    res = verifyCheckpointFile(checkpointPath);
  } catch (e) {
    if (e instanceof ChainError) {
      console.log(JSON.stringify({ ok: false, reason: 'chain_break', detail: e.reason, index: e.index }));
      process.exitCode = EXIT_CHAIN;
      return;
    }
    process.stderr.write(JSON.stringify({ error: 'verify_io', message: e.message }) + '\n');
    process.exitCode = 1;
    return;
  }
  console.log(JSON.stringify(res));
  if (!res.ok) process.exitCode = 1;
}

const args = process.argv.slice(2);
if (args[0] === 'verify' && args[1]) {
  cmdVerify(args[1]);
} else if (args[0] && args[0] !== 'verify') {
  cmdRun(args[0]);
} else {
  process.stderr.write('usage: node cli.js <frames.bin> | node cli.js verify <checkpoint.json>\n');
  process.exitCode = 64;
}
