#!/usr/bin/env node
import { writeFileSync } from 'node:fs';
import {
  readJsonl,
  writeJsonl,
  appendRecord,
  dedupeByHash,
  canonicalOrder,
  verifyRecords,
  RECORD_TYPES,
} from '../src/index.js';

const USAGE = `ebr - offline EBR sha256-chain tool

usage:
  ebr append <log.jsonl> --site <S> --gen <N> --type <T> [--payload <json>]
  ebr merge  <out.jsonl> <in1.jsonl> [in2.jsonl ...]
  ebr verify <log.jsonl>
  ebr export <log.jsonl> [--out <cert.json>]

record types: ${[...RECORD_TYPES].join(', ')}
exit codes: 0 ok/unknown, 15 broken chain, 16 low-generation backfill
`;

function parseFlags(args) {
  const positional = [];
  const flags = {};
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg.startsWith('--')) {
      const key = arg.slice(2);
      const value = args[i + 1];
      if (value === undefined || value.startsWith('--')) throw new Error(`flag --${key} needs a value`);
      flags[key] = value;
      i += 1;
    } else {
      positional.push(arg);
    }
  }
  return { positional, flags };
}

function cmdAppend(args) {
  const { positional, flags } = parseFlags(args);
  const [logPath] = positional;
  if (!logPath || !flags.site || !flags.type) throw new Error('append needs <log.jsonl> --site <S> --type <T>');
  const gen = Number(flags.gen);
  if (!Number.isInteger(gen) || gen < 1) throw new Error('append needs --gen <positive integer>');
  if (!RECORD_TYPES.has(flags.type)) throw new Error(`unknown type: ${flags.type}`);
  const payload = flags.payload === undefined ? {} : JSON.parse(flags.payload);
  let records = [];
  try {
    records = readJsonl(logPath);
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  const record = appendRecord(records, { type: flags.type, site: flags.site, gen, payload });
  writeJsonl(logPath, [...records, record]);
  process.stdout.write(JSON.stringify(record) + '\n');
  return 0;
}

function cmdMerge(args) {
  const { positional } = parseFlags(args);
  const [outPath, ...inputs] = positional;
  if (!outPath || inputs.length === 0) throw new Error('merge needs <out.jsonl> <in1.jsonl> [in2.jsonl ...]');
  const merged = dedupeByHash(inputs.flatMap((p) => readJsonl(p)));
  writeJsonl(outPath, canonicalOrder(merged));
  process.stdout.write(JSON.stringify({ merged: merged.length, out: outPath }) + '\n');
  return 0;
}

function cmdVerify(args) {
  const { positional } = parseFlags(args);
  const [logPath] = positional;
  if (!logPath) throw new Error('verify needs <log.jsonl>');
  const { exitCode, certificate } = verifyRecords(readJsonl(logPath));
  process.stdout.write(JSON.stringify(certificate, null, 2) + '\n');
  return exitCode;
}

function cmdExport(args) {
  const { positional, flags } = parseFlags(args);
  const [logPath] = positional;
  if (!logPath) throw new Error('export needs <log.jsonl>');
  const records = readJsonl(logPath);
  const { exitCode, certificate } = verifyRecords(records);
  const maskedHashes = new Set(certificate.masked.map((m) => m.hash));
  const effective = canonicalOrder(dedupeByHash(records)).filter((r) => !maskedHashes.has(r.hash));
  const document = { certificate, effective };
  const text = JSON.stringify(document, null, 2) + '\n';
  if (flags.out) {
    writeFileSync(flags.out, text);
    process.stdout.write(JSON.stringify({ exported: flags.out, status: certificate.status }) + '\n');
  } else {
    process.stdout.write(text);
  }
  return exitCode;
}

function main() {
  const [command, ...rest] = process.argv.slice(2);
  try {
    switch (command) {
      case 'append': return cmdAppend(rest);
      case 'merge': return cmdMerge(rest);
      case 'verify': return cmdVerify(rest);
      case 'export': return cmdExport(rest);
      default:
        process.stderr.write(USAGE);
        return command === undefined || command === 'help' || command === '--help' ? 0 : 2;
    }
  } catch (error) {
    process.stderr.write(`error: ${error.message}\n`);
    return 2;
  }
}

process.exitCode = main();
