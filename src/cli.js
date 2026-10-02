#!/usr/bin/env node
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { mergeBranches } from './merge.js';

const USAGE = `Usage: node src/cli.js merge --base <base.json> --a <branchA.json> --b <branchB.json> [--out-dir <dir>]

Record:   { "value": <any>, "quality": <any>, "reviewed": <boolean> }
Branch:   { "author": "observer-id", "sourceLevel": <int>,
            "vectorClock": { "<observer-id>": <int>, ... },
            "changes": { "value": { "old": ..., "new": ... }, ... } }

Exit codes: 0 merged (writes merged.json + decision-log.json)
            2 conflict (writes decision-log.json + conflicts.json)
            1 usage / IO error`;

async function main(argv) {
  const [command, ...rest] = argv;
  if (command !== 'merge') {
    console.error(USAGE);
    return 1;
  }
  const { values } = parseArgs({
    args: rest,
    options: {
      base: { type: 'string' },
      a: { type: 'string' },
      b: { type: 'string' },
      'out-dir': { type: 'string', default: '.' },
    },
  });
  if (!values.base || !values.a || !values.b) {
    console.error(USAGE);
    return 1;
  }

  const readJson = async (path) => JSON.parse(await readFile(path, 'utf8'));
  const base = await readJson(values.base);
  const branchA = await readJson(values.a);
  const branchB = await readJson(values.b);

  const result = mergeBranches({ base, branchA, branchB });
  const outDir = values['out-dir'];
  const writeJson = (name, data) =>
    writeFile(join(outDir, name), `${JSON.stringify(data, null, 2)}\n`);

  await writeJson('decision-log.json', {
    status: result.status,
    decisions: result.decisions,
  });

  if (result.status === 'conflict') {
    await writeJson('conflicts.json', result.conflicts);
    for (const c of result.conflicts) {
      console.error(`conflict: field=${c.field} reason=${c.reason} sha256=${c.sha256}`);
    }
    return 2;
  }

  await writeJson('merged.json', result.merged);
  console.log('merged: wrote merged.json and decision-log.json');
  return 0;
}

main(process.argv.slice(2)).then(
  (code) => process.exit(code),
  (err) => {
    console.error(`error: ${err.message}`);
    process.exit(1);
  },
);
