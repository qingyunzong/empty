#!/usr/bin/env node
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { mergeDatasets } from './merge.js';
import { buildCertificate, serialize } from './certificate.js';

const USAGE = `Usage: merge <base.json> <left.json> <right.json> --out <dir>

Three-way merge of scientific observation datasets (JSON objects keyed by record id).

Exit codes:
  0  clean merge  -> writes merged.json and certificate.json
  2  conflicts    -> writes conflicts.json only (no partial merge)
  1  usage or I/O error
`;

class CliError extends Error {}

function parseArgs(argv) {
  const [command, ...rest] = argv;
  if (command !== 'merge') return null;
  const files = [];
  let outDir = null;
  for (let i = 0; i < rest.length; i += 1) {
    if (rest[i] === '--out') {
      outDir = rest[i + 1];
      i += 1;
    } else if (rest[i].startsWith('--out=')) {
      outDir = rest[i].slice('--out='.length);
    } else {
      files.push(rest[i]);
    }
  }
  if (files.length !== 3 || !outDir) return null;
  return { files, outDir };
}

function readJson(path) {
  let text;
  try {
    text = readFileSync(path, 'utf8');
  } catch (err) {
    throw new CliError(`cannot read ${path}: ${err.message}`);
  }
  try {
    return JSON.parse(text);
  } catch (err) {
    throw new CliError(`invalid JSON in ${path}: ${err.message}`);
  }
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args) {
    process.stderr.write(USAGE);
    process.exitCode = 1;
    return;
  }

  let result;
  let inputs;
  try {
    inputs = args.files.map(readJson);
    result = mergeDatasets(...inputs);
  } catch (err) {
    process.stderr.write(`error: ${err.message}\n`);
    process.exitCode = 1;
    return;
  }

  mkdirSync(args.outDir, { recursive: true });

  if (result.conflicts.length > 0) {
    const payload = {
      status: 'conflict',
      stats: result.stats,
      conflicts: result.conflicts,
    };
    writeFileSync(join(args.outDir, 'conflicts.json'), serialize(payload));
    process.stderr.write(
      `merge failed: ${result.conflicts.length} conflict(s); wrote conflicts.json\n`,
    );
    process.exitCode = 2;
    return;
  }

  const [base, left, right] = inputs;
  const certificate = buildCertificate({
    base,
    left,
    right,
    merged: result.merged,
    stats: result.stats,
  });
  writeFileSync(join(args.outDir, 'merged.json'), serialize(result.merged));
  writeFileSync(join(args.outDir, 'certificate.json'), serialize(certificate));
  process.stdout.write(
    `merged ${result.stats.records} record(s); wrote merged.json and certificate.json\n`,
  );
  process.exitCode = 0;
}

main();
