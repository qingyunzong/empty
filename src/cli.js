#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { writePackage, readPackage } from './codec.js';
import { crc32 } from './crc32.js';
import { Decoder, DecodeError } from './decoder.js';

export const EXIT_CODES = { E_CRC: 3, E_DEPTH: 4, E_TARGET: 5 };

const USAGE = `usage:
  cnc-pack encode <outdir> [--main <name>] [--block-lines <n>] <file.nc...>
  cnc-pack verify <pkgdir>
  cnc-pack decode <pkgdir> [--from <seq>] [--max-depth <n>]`;

function parseFlags(args, names) {
  const pos = [];
  const opts = {};
  for (let i = 0; i < args.length; i++) {
    if (names.includes(args[i])) {
      opts[args[i]] = args[++i];
    } else {
      pos.push(args[i]);
    }
  }
  return { pos, opts };
}

function cmdEncode(args, io) {
  const { pos, opts } = parseFlags(args, ['--main', '--block-lines']);
  const outdir = pos.shift();
  if (!outdir || pos.length === 0) return usage(io);
  const sources = pos.map((f) => ({
    name: path.basename(f).replace(/\.[^.]*$/, ''),
    text: fs.readFileSync(f, 'utf8'),
  }));
  const encOpts = {};
  if (opts['--main']) encOpts.main = opts['--main'];
  if (opts['--block-lines']) encOpts.blockLines = Number(opts['--block-lines']);
  const index = writePackage(outdir, sources, encOpts);
  io.out(`encoded ${index.blockCount} blocks, main=${index.main}`);
  for (const [name, p] of Object.entries(index.programs)) {
    io.out(`  ${name}: blocks ${p.start}..${p.end} entry=${p.entry}`);
  }
  return 0;
}

function cmdVerify(args, io) {
  const [dir] = args;
  if (!dir) return usage(io);
  const { index, blocks } = readPackage(dir);
  for (let seq = 0; seq < index.blockCount; seq++) {
    const block = blocks.get(seq);
    if (!block) {
      io.err(`E_MISSING block ${seq}`);
      return 2;
    }
    if (crc32(block.payload) !== block.crc) {
      io.err(`E_CRC block ${seq}`);
      return EXIT_CODES.E_CRC;
    }
  }
  io.out(`OK ${index.blockCount} blocks verified`);
  return 0;
}

function cmdDecode(args, io) {
  const { pos, opts } = parseFlags(args, ['--from', '--max-depth']);
  const [dir] = pos;
  if (!dir) return usage(io);
  const from = opts['--from'] !== undefined ? Number(opts['--from']) : 0;
  const maxDepth = opts['--max-depth'] !== undefined ? Number(opts['--max-depth']) : 8;
  const { index, blocks } = readPackage(dir);
  try {
    const decoder = new Decoder(index, { maxDepth, recordTrace: false });
    // Replay the confirmed prefix without re-executing (no trace output).
    for (let seq = 0; seq < from && seq < index.blockCount; seq++) {
      const b = blocks.get(seq);
      if (b) decoder.addBlock(b.seq, b.crc, b.payload);
    }
    decoder.run();
    decoder.recordTrace = true;
    for (let seq = Math.max(from, 0); seq < index.blockCount; seq++) {
      const b = blocks.get(seq);
      if (b) decoder.addBlock(b.seq, b.crc, b.payload);
    }
    const status = decoder.run();
    for (const t of status.trace) {
      io.out(`${t.seq} ${t.prog}:${t.line} ${t.text}`);
    }
    io.out(`CONFIRMED ${status.confirmed}`);
    io.out(status.nextSeq === null ? 'NEXT none' : `NEXT ${status.nextSeq}`);
    io.out(status.done ? 'DONE' : `BLOCKED waiting=${status.waitingFor}`);
    return 0;
  } catch (err) {
    if (err instanceof DecodeError) {
      io.err(`${err.code} ${err.message}`);
      return EXIT_CODES[err.code] ?? 1;
    }
    throw err;
  }
}

function usage(io) {
  io.err(USAGE);
  return 1;
}

// Runs the CLI; returns the process exit code instead of calling process.exit
// so tests can drive it in-process.
export function runCli(argv, io = { out: console.log, err: console.error }) {
  const [cmd, ...args] = argv;
  if (cmd === 'encode') return cmdEncode(args, io);
  if (cmd === 'verify') return cmdVerify(args, io);
  if (cmd === 'decode') return cmdDecode(args, io);
  return usage(io);
}

const isMain =
  process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;
if (isMain) {
  process.exit(runCli(process.argv.slice(2)));
}
