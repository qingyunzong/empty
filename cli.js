#!/usr/bin/env node
'use strict';

// ---------------------------------------------------------------------------
// Merchant refund risk-control service CLI.
//
//   node cli.js <ops.jsonl> [--config config.json] [--wal wal.bin]
//
// Input: newline-delimited JSON frames {"seq","ack","t","op":{...}}.
// Output: one ack JSON per decided frame, then a final snapshot JSON with
// per-key state, budget usage, reject codes and the audit hash chain head.
//
// Exit codes: 0 ok | 2 frame error | 3 key conflict | 4 limit exceeded.
// ---------------------------------------------------------------------------

const fs = require('node:fs');
const crypto = require('node:crypto');
const { Core } = require('./src/core');
const { Wal } = require('./src/wal');
const { Protocol, FrameError, parseFrame } = require('./src/protocol');

const EXIT = { OK: 0, FRAME: 2, CONFLICT: 3, LIMIT: 4 };

function sha256(text) {
  return crypto.createHash('sha256').update(text, 'utf8').digest('hex');
}

function parseArgs(argv, io) {
  const args = { config: null, wal: null, ops: null, audit: false };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--config') args.config = argv[++i];
    else if (a === '--wal') args.wal = argv[++i];
    else if (a === '--audit') args.audit = true;
    else if (a.startsWith('--config=')) args.config = a.slice(9);
    else if (a.startsWith('--wal=')) args.wal = a.slice(6);
    else if (args.ops === null) args.ops = a;
    else {
      io.error(`unexpected argument: ${a}`);
      return null;
    }
  }
  if (!args.ops) {
    io.error('usage: node cli.js <ops.jsonl> [--config config.json] [--wal wal.bin] [--audit]');
    return null;
  }
  return args;
}

function main(argv, io = { log: console.log, error: console.error }) {
  const args = parseArgs(argv, io);
  if (!args) return EXIT.FRAME;
  const walPath = args.wal || args.ops + '.wal';

  const wal = new Wal(walPath);
  const { records, truncatedBytes } = wal.open();

  let config = { budgetLimit: 1000, slaMs: 1000, highRiskTags: ['high'] };
  if (args.config) config = { ...config, ...JSON.parse(fs.readFileSync(args.config, 'utf8')) };

  const core = new Core(config);
  core.setHasher(sha256);
  const protocol = new Protocol();
  let sawConflict = false;
  let sawLimit = false;

  const noteResult = (result) => {
    if (result && result.status === 'conflict') sawConflict = true;
    if (result && result.code === 'LIMIT_EXCEEDED') sawLimit = true;
  };

  // --- recovery: replay the WAL, rebuilding core + protocol state ----------
  let replayedConfig = null;
  for (const rec of records) {
    if (rec.kind === 'config') {
      replayedConfig = rec.config;
    } else if (rec.kind === 'frame') {
      const result = core.apply(rec.op, rec.t);
      protocol.results.set(rec.seq, result);
      protocol.expected = rec.seq + 1;
      noteResult(result);
    }
  }
  if (replayedConfig) {
    // A previous run's configuration wins: replay must be deterministic.
    core.config = { ...core.config, ...replayedConfig, highRiskTags: new Set(replayedConfig.highRiskTags) };
  } else {
    wal.append({ kind: 'config', config: { ...config, highRiskTags: [...config.highRiskTags] } });
  }
  if (truncatedBytes > 0) {
    io.error(`wal: recovered after truncating ${truncatedBytes} corrupt tail byte(s)`);
  }

  // --- live processing -----------------------------------------------------
  const raw = fs.readFileSync(args.ops, 'utf8');
  const lines = raw.split('\n');
  const acks = [];

  const applyAndLog = (op, t) => core.apply(op, t);

  for (let lineNo = 0; lineNo < lines.length; lineNo++) {
    const line = lines[lineNo].trim();
    if (line === '') continue;
    let frame;
    try {
      frame = parseFrame(line);
    } catch (err) {
      if (err instanceof FrameError) {
        io.error(`frame error at line ${lineNo + 1}: ${err.message}`);
        wal.close();
        return EXIT.FRAME;
      }
      throw err;
    }
    const ready = protocol.ingest(frame, (op, t, seq) => {
      const result = applyAndLog(op, t);
      wal.append({ kind: 'frame', seq, t, op, result });
      return result;
    });
    for (const entry of ready) {
      acks.push(entry);
      noteResult(entry.result);
    }
  }

  for (const entry of acks) {
    const out = { ack: entry.ack, result: entry.result };
    if (entry.dup) out.dup = true;
    io.log(JSON.stringify(out));
  }
  io.log(JSON.stringify({ snapshot: core.snapshot() }));
  if (args.audit) {
    for (const entry of core.audit) io.log(JSON.stringify({ audit: entry }));
  }

  wal.close();
  if (sawConflict) return EXIT.CONFLICT;
  if (sawLimit) return EXIT.LIMIT;
  return EXIT.OK;
}

if (require.main === module) {
  // Set exitCode (not process.exit) so piped stdout is fully flushed.
  process.exitCode = main(process.argv);
}

module.exports = { main, EXIT };
