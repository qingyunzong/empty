#!/usr/bin/env node
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { rebase, validateHistory, RebaseError } from './rebase.js';

// Runs the CLI and returns an exit code. Errors are reported via `stderr`.
export function run(argv, stderr = (s) => process.stderr.write(s)) {
  let values;
  try {
    ({ values } = parseArgs({
      args: argv,
      options: {
        history: { type: 'string', short: 'f', default: 'history.json' },
        branch: { type: 'string', short: 'b' },
        onto: { type: 'string', short: 'o' },
        'out-dir': { type: 'string', short: 'd', default: '.' },
      },
      allowPositionals: true,
    }));
  } catch (err) {
    stderr(`error: ${err.message}\n`);
    return 1;
  }
  const command = argv[0];
  if (command !== 'rebase' || !values.branch || !values.onto) {
    stderr('error: usage: node src/cli.js rebase --history <file> --branch <ref> --onto <ref> [--out-dir <dir>]\n');
    return 1;
  }

  let history;
  try {
    history = JSON.parse(readFileSync(resolve(values.history), 'utf8'));
  } catch (err) {
    stderr(`error: cannot read history file: ${err.message}\n`);
    return 1;
  }
  const commits = history.commits ?? [];
  const branches = history.branches ?? {};

  try {
    // Validate first so that --branch/--onto given as numbers resolve to computed hashes.
    const byHash = validateHistory(commits);
    const resolveHash = (ref) => {
      if (Object.hasOwn(branches, ref)) return branches[ref];
      const numeric = [...byHash.values()].filter((c) => String(c.number) === ref);
      if (numeric.length === 1) return numeric[0].hash;
      return ref;
    };
    const result = rebase(commits, resolveHash(values.branch), resolveHash(values.onto));
    // Nothing is written before this point: a conflict above aborts with no output.
    const outDir = resolve(values['out-dir']);
    mkdirSync(outDir, { recursive: true });
    writeFileSync(resolve(outDir, 'rebased.json'), JSON.stringify(result.commits, null, 2) + '\n');
    writeFileSync(resolve(outDir, 'mapping.json'), JSON.stringify(result.mapping, null, 2) + '\n');
    console.log(`rebased ${result.commits.length} commit(s); ` +
      `${Object.values(result.mapping).filter((v) => v === null).length} empty commit(s) collapsed`);
    console.log(`wrote ${resolve(outDir, 'rebased.json')} and ${resolve(outDir, 'mapping.json')}`);
    return 0;
  } catch (err) {
    if (err instanceof RebaseError) {
      stderr(`error: ${err.code}: ${err.message}\n`);
      return 1;
    }
    throw err;
  }
}

const invokedAsScript = process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href;
if (invokedAsScript) {
  process.exitCode = run(process.argv.slice(2));
}
