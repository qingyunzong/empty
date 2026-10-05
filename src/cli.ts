#!/usr/bin/env node
/**
 * doc-merge — three-way line-based document merge.
 *
 * Usage:
 *   doc-merge merge <base> <ours> <theirs> [--labels O,B,T] [--json]
 *   doc-merge unmerge <merged> [--json]
 *
 * `merge` prints the merged document to stdout (exit 0 when clean, 1 when
 * conflicts remain). With --json it prints the full reversible MergeResult.
 * `unmerge` reconstructs the three original documents from a merged file
 * (default: writes base/ours/theirs next to it as <file>.{base,ours,theirs};
 * with --json prints them as JSON instead).
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { parseArgs } from 'node:util';
import {
  merge3,
  unmerge,
  splitLines,
  joinLines,
  DEFAULT_LABELS,
  type MergeLabels,
} from './merge.js';

function usage(): never {
  console.error(
    [
      'usage:',
      '  doc-merge merge <base> <ours> <theirs> [--labels O,B,T] [--json]',
      '  doc-merge unmerge <merged> [--json]',
    ].join('\n'),
  );
  process.exit(2);
}

function readLines(path: string): string[] {
  try {
    return splitLines(readFileSync(path, 'utf8'));
  } catch {
    console.error(`doc-merge: cannot read ${path}`);
    process.exit(2);
  }
}

function parseLabels(raw: string | undefined): MergeLabels {
  if (!raw) return DEFAULT_LABELS;
  const parts = raw.split(',');
  if (parts.length !== 3 || parts.some((p) => p === '')) {
    console.error('doc-merge: --labels must be "ours,base,theirs"');
    process.exit(2);
  }
  return { ours: parts[0], base: parts[1], theirs: parts[2] };
}

function cmdMerge(argv: string[]): number {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      labels: { type: 'string' },
      json: { type: 'boolean', default: false },
    },
  });
  if (positionals.length !== 3) usage();
  const [basePath, oursPath, theirsPath] = positionals;
  const labels = parseLabels(values.labels);
  const result = merge3(
    readLines(basePath),
    readLines(oursPath),
    readLines(theirsPath),
    labels,
  );
  if (values.json) {
    console.log(JSON.stringify(result, null, 2));
  } else {
    process.stdout.write(result.text);
  }
  if (!result.clean) {
    console.error(`doc-merge: ${result.conflicts.length} conflict(s)`);
    return 1;
  }
  return 0;
}

function cmdUnmerge(argv: string[]): number {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      json: { type: 'boolean', default: false },
    },
  });
  if (positionals.length !== 1) usage();
  const path = positionals[0];
  let docs;
  try {
    docs = unmerge(readFileSync(path, 'utf8'));
  } catch (err) {
    console.error(`doc-merge: ${(err as Error).message}`);
    return 2;
  }
  if (values.json) {
    console.log(JSON.stringify(docs, null, 2));
  } else {
    writeFileSync(`${path}.base`, joinLines(docs.base));
    writeFileSync(`${path}.ours`, joinLines(docs.ours));
    writeFileSync(`${path}.theirs`, joinLines(docs.theirs));
    console.error(
      `doc-merge: wrote ${path}.base, ${path}.ours, ${path}.theirs`,
    );
  }
  return 0;
}

function main(argv: string[]): number {
  const [cmd, ...rest] = argv;
  if (cmd === 'merge') return cmdMerge(rest);
  if (cmd === 'unmerge') return cmdUnmerge(rest);
  usage();
}

process.exit(main(process.argv.slice(2)));
