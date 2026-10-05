#!/usr/bin/env node
/**
 * merge3 — line-based three-way document merge.
 *
 * Usage:
 *   merge3 [merge] <base> <ours> <theirs> [--out FILE] [--json FILE]
 *          [--label-ours L] [--label-theirs L] [--label-base L]
 *   merge3 revert --result FILE --side base|ours|theirs [--merged FILE] [--out FILE]
 *
 * Exit codes: 0 = clean merge / success, 1 = conflicts found, 2 = usage or I/O error.
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { parseArgs } from 'node:util';
import * as process from 'node:process';
import {
  DEFAULT_LABELS,
  merge3,
  revert,
  type Labels,
  type MergeResult,
  type Side,
} from './merge.js';

const USAGE = `Usage:
  merge3 [merge] <base> <ours> <theirs> [--out FILE] [--json FILE]
         [--label-ours L] [--label-theirs L] [--label-base L]
  merge3 revert --result FILE --side base|ours|theirs [--merged FILE] [--out FILE]

Exit codes: 0 = clean, 1 = conflicts, 2 = error.`;

function fail(message: string): never {
  process.stderr.write(`merge3: ${message}\n`);
  process.exit(2);
}

function asString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function commandMerge(args: string[]): number {
  const { values, positionals } = parseArgs({
    args,
    allowPositionals: true,
    options: {
      out: { type: 'string' },
      json: { type: 'string' },
      'label-ours': { type: 'string' },
      'label-theirs': { type: 'string' },
      'label-base': { type: 'string' },
    },
  });
  if (positionals.length !== 3) fail(`expected 3 files (base ours theirs)\n${USAGE}`);
  const [baseFile, oursFile, theirsFile] = positionals;
  let base: string, ours: string, theirs: string;
  try {
    base = readFileSync(baseFile, 'utf8');
    ours = readFileSync(oursFile, 'utf8');
    theirs = readFileSync(theirsFile, 'utf8');
  } catch (err) {
    fail(`cannot read input: ${(err as Error).message}`);
  }
  const labels: Labels = {
    ours: asString(values['label-ours']) ?? DEFAULT_LABELS.ours,
    theirs: asString(values['label-theirs']) ?? DEFAULT_LABELS.theirs,
    base: asString(values['label-base']) ?? DEFAULT_LABELS.base,
  };
  const result: MergeResult = merge3(base, ours, theirs, labels);
  const outFile = asString(values.out);
  if (outFile !== undefined) writeFileSync(outFile, result.merged);
  else process.stdout.write(result.merged);
  const jsonFile = asString(values.json);
  if (jsonFile !== undefined) writeFileSync(jsonFile, JSON.stringify(result, null, 2) + '\n');
  if (!result.clean) {
    process.stderr.write(`merge3: ${result.conflictCount} conflict(s)\n`);
    return 1;
  }
  return 0;
}

function commandRevert(args: string[]): number {
  const { values } = parseArgs({
    args,
    allowPositionals: false,
    options: {
      result: { type: 'string' },
      side: { type: 'string' },
      merged: { type: 'string' },
      out: { type: 'string' },
    },
  });
  const resultFile = asString(values.result);
  const side = asString(values.side);
  if (resultFile === undefined || side === undefined) {
    fail(`revert requires --result and --side\n${USAGE}`);
  }
  if (side !== 'base' && side !== 'ours' && side !== 'theirs') {
    fail(`--side must be base, ours or theirs, got ${JSON.stringify(side)}`);
  }
  let result: MergeResult;
  let mergedText: string;
  try {
    result = JSON.parse(readFileSync(resultFile, 'utf8')) as MergeResult;
    const mergedFile = asString(values.merged);
    mergedText =
      mergedFile !== undefined ? readFileSync(mergedFile, 'utf8') : readFileSync(process.stdin.fd, 'utf8');
  } catch (err) {
    fail(`cannot read input: ${(err as Error).message}`);
  }
  let reverted: string;
  try {
    reverted = revert(mergedText, result, side as Side);
  } catch (err) {
    fail((err as Error).message);
  }
  const outFile = asString(values.out);
  if (outFile !== undefined) writeFileSync(outFile, reverted);
  else process.stdout.write(reverted);
  return 0;
}

function main(argv: string[]): number {
  const args = [...argv];
  if (args[0] === 'revert') return commandRevert(args.slice(1));
  if (args[0] === 'merge') args.shift();
  if (args.length === 0 || args.includes('--help') || args.includes('-h')) {
    process.stdout.write(USAGE + '\n');
    return args.length === 0 ? 2 : 0;
  }
  return commandMerge(args);
}

process.exit(main(process.argv.slice(2)));
