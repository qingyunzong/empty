#!/usr/bin/env node
import { readFileSync, writeSync } from 'node:fs';
import {
  BatchError,
  executeBatch,
  findJournals,
  resumeJournal,
  type EngineHooks,
  type RenamePair,
} from './mvbatch.ts';

const USAGE = `Usage:
  mvbatch <src> <dst> [<src> <dst> ...]   atomic batch rename (swaps and cycles allowed)
  mvbatch --plan <file.json>              read pairs from JSON: [["src","dst"],...]
  mvbatch --resume [journal ...]          finish an interrupted batch from its journal

Environment:
  MVBATCH_FAIL_AT=<n>   simulate a power loss right before rename step <n>
`;

// stderr is a pipe under the test runner, so write synchronously before
// exiting; process.exit() would otherwise truncate pending output.
function fail(message: string, code = 1): never {
  writeSync(2, `mvbatch: ${message}\n`);
  process.exit(code);
}

function crashInjectionHooks(): EngineHooks {
  return {
    beforeRename: (step: number): void => {
      const failAt = process.env.MVBATCH_FAIL_AT;
      if (failAt !== undefined && Number(failAt) === step) {
        writeSync(2, `mvbatch: simulated power loss before rename step ${step}\n`);
        process.exit(75);
      }
    },
  };
}

function runNewBatch(pairs: RenamePair[], cwd: string, hooks: EngineHooks): void {
  const pending = findJournals(cwd);
  if (pending.length > 0) {
    fail(`unfinished batch journal present (${pending.join(', ')}); run "mvbatch --resume" first`);
  }
  executeBatch(pairs, cwd, hooks);
}

function parsePlanFile(file: string): RenamePair[] {
  const raw = JSON.parse(readFileSync(file, 'utf8')) as unknown[];
  if (!Array.isArray(raw)) throw new BatchError('plan file must contain a JSON array');
  return raw.map((item) => {
    if (Array.isArray(item)) return { src: String(item[0]), dst: String(item[1]) };
    const pair = item as RenamePair;
    return { src: String(pair.src), dst: String(pair.dst) };
  });
}

export function main(argv: string[]): void {
  const hooks = crashInjectionHooks();
  const cwd = process.cwd();
  const [cmd, ...rest] = argv;
  try {
    if (cmd === '--resume') {
      const journals = rest.length > 0 ? rest : findJournals(cwd);
      if (journals.length === 0) fail('no journal found; nothing to resume');
      for (const journal of journals) {
        resumeJournal(journal, hooks);
        console.error(`mvbatch: resumed batch completed (${journal})`);
      }
      return;
    }
    if (cmd === '--plan') {
      const file = rest[0];
      if (!file) fail('missing plan file', 2);
      runNewBatch(parsePlanFile(file), cwd, hooks);
      return;
    }
    if (argv.length === 0 || argv.length % 2 !== 0) {
      writeSync(2, USAGE);
      process.exit(2);
    }
    const pairs: RenamePair[] = [];
    for (let i = 0; i < argv.length; i += 2) {
      pairs.push({ src: argv[i], dst: argv[i + 1] });
    }
    runNewBatch(pairs, cwd, hooks);
  } catch (err) {
    if (err instanceof BatchError) fail(err.message);
    throw err;
  }
}

main(process.argv.slice(2));
