#!/usr/bin/env node
import fs from 'node:fs';
import { encodePackage, readIndex, readAllRecords, verifyPackage } from '../src/package.js';
import { Decoder } from '../src/decoder.js';
import { CncError, E } from '../src/errors.js';

const EXIT_CODES = {
  [E.CRC]: 10,
  [E.DEPTH]: 11,
  [E.TARGET]: 12,
  [E.DUP]: 13,
  [E.FORMAT]: 14,
};

const USAGE = `usage:
  cnc encode <program.nc> -o <base> [--block-lines K]
  cnc verify <base>
  cnc decode <base> [--max-depth D] [--upto K] [--from K] [--state FILE] [--events FILE]`;

function parseArgs(argv) {
  const args = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '-o') args.o = argv[++i];
    else if (a.startsWith('--')) {
      const key = a.slice(2);
      const next = argv[i + 1];
      if (next === undefined || next.startsWith('--')) args[key] = true;
      else { args[key] = next; i++; }
    } else args._.push(a);
  }
  return args;
}

function cmdEncode(args) {
  const src = args._[0];
  if (!src || !args.o) throw new CncError(E.FORMAT, 'encode needs <program.nc> and -o <base>');
  const source = fs.readFileSync(src, 'utf8');
  const blockLines = args['block-lines'] ? Number(args['block-lines']) : 4;
  const index = encodePackage(source, args.o, { blockLines });
  console.log(JSON.stringify({
    program: index.programName,
    blocks: index.blockCount,
    range: index.range,
    entry: index.entry,
  }));
}

function cmdVerify(args) {
  if (!args._[0]) throw new CncError(E.FORMAT, 'verify needs <base>');
  const result = verifyPackage(args._[0]);
  console.log(JSON.stringify(result));
}

function cmdDecode(args) {
  const base = args._[0];
  if (!base) throw new CncError(E.FORMAT, 'decode needs <base>');
  const index = readIndex(base);
  const records = readAllRecords(base, index);
  let dec;
  if (args.state && fs.existsSync(args.state)) {
    dec = Decoder.restore(JSON.parse(fs.readFileSync(args.state, 'utf8')));
  } else {
    dec = new Decoder({
      maxDepth: args['max-depth'] !== undefined ? Number(args['max-depth']) : 8,
      totalBlocks: index.blockCount,
    });
  }
  if (dec.totalBlocks === null || dec.totalBlocks === undefined) dec.totalBlocks = index.blockCount;
  const upto = args.upto !== undefined ? Number(args.upto) : null;
  const from = args.from !== undefined ? Number(args.from) : null;
  for (const rec of records) {
    if (upto !== null && rec.seq >= upto) continue;
    if (from !== null && rec.seq < from) continue;
    dec.ingest(rec);
  }
  const before = dec.events.length;
  dec.run();
  const newEvents = dec.events.slice(before);
  if (args.state) {
    const tmp = `${args.state}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(dec.snapshot()));
    fs.renameSync(tmp, args.state);
  }
  if (args.events) {
    fs.writeFileSync(args.events, newEvents.map((e) => JSON.stringify(e)).join('\n') + (newEvents.length ? '\n' : ''));
  } else {
    for (const e of newEvents) console.log(JSON.stringify(e));
  }
  console.log(JSON.stringify({
    summary: { confirmed: dec.ack, next: dec.ack, done: dec.done, events: newEvents.length },
  }));
}

function main() {
  const [cmd, ...rest] = process.argv.slice(2);
  if (!cmd) {
    console.error(USAGE);
    process.exit(2);
  }
  const args = parseArgs(rest);
  try {
    if (cmd === 'encode') cmdEncode(args);
    else if (cmd === 'verify') cmdVerify(args);
    else if (cmd === 'decode') cmdDecode(args);
    else {
      console.error(USAGE);
      process.exit(2);
    }
  } catch (err) {
    if (err instanceof CncError) {
      console.error(`error ${err.code}: ${err.message}`);
      process.exit(EXIT_CODES[err.code] ?? 1);
    }
    console.error(`error: ${err.message}`);
    process.exit(1);
  }
}

main();
