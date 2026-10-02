#!/usr/bin/env node
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { mergeDatasets } from './merge.js';
import { buildCertificate } from './certificate.js';

const USAGE = 'Usage: obs3merge merge <base.json> <left.json> <right.json> --out <dir>';

function readDataset(filePath) {
  const content = readFileSync(filePath, 'utf8');
  const data = JSON.parse(content);
  if (data === null || typeof data !== 'object' || Array.isArray(data)) {
    throw new Error(`${filePath}: top-level value must be an object keyed by record id`);
  }
  return { content, data };
}

export function main(argv) {
  let positionals;
  let values;
  try {
    ({ positionals, values } = parseArgs({
      args: argv,
      allowPositionals: true,
      options: { out: { type: 'string' } },
    }));
  } catch (err) {
    console.error(err.message);
    console.error(USAGE);
    return 1;
  }

  const [command, basePath, leftPath, rightPath] = positionals;
  if (command !== 'merge' || !basePath || !leftPath || !rightPath || !values.out) {
    console.error(USAGE);
    return 1;
  }

  let base;
  let left;
  let right;
  try {
    base = readDataset(basePath);
    left = readDataset(leftPath);
    right = readDataset(rightPath);
  } catch (err) {
    console.error(`error: ${err.message}`);
    return 1;
  }

  const { merged, conflicts } = mergeDatasets(base.data, left.data, right.data);

  const outDir = values.out;
  mkdirSync(outDir, { recursive: true });

  if (conflicts.length > 0) {
    writeFileSync(
      path.join(outDir, 'conflicts.json'),
      JSON.stringify({ conflictCount: conflicts.length, conflicts }, null, 2) + '\n',
    );
    console.error(`merge failed: ${conflicts.length} conflict(s); see ${path.join(outDir, 'conflicts.json')}`);
    return 2;
  }

  writeFileSync(
    path.join(outDir, 'merged.json'),
    JSON.stringify(merged, null, 2) + '\n',
  );
  const certificate = buildCertificate({
    merged,
    inputs: { base: base.content, left: left.content, right: right.content },
  });
  writeFileSync(
    path.join(outDir, 'certificate.json'),
    JSON.stringify(certificate, null, 2) + '\n',
  );
  console.log(`merged ${certificate.recordCount} record(s); certificate sha256=${certificate.mergedDigest}`);
  return 0;
}

const invokedAsScript = process.argv[1]
  && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;

if (invokedAsScript) {
  process.exit(main(process.argv.slice(2)));
}
