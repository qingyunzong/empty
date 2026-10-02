#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { Store } = require('./lib/store');
const { mergeVersions, DEFAULT_EXCLUSIVE_GROUPS } = require('./lib/merge');
const vclock = require('./lib/vclock');
const { LineageError } = require('./lib/version');

const USAGE = `Usage: node cli.js <command> [args] [--store DIR] [--conflicts FILE] [--exclusive-groups JSON]

Commands:
  add <version.json>            Validate, hash and store a version; prints its lineage hash
  merge <hashA> <hashB>         Fast-forward or merge two versions
                                exit 0 on success, 2 on contradiction (writes pairwise-conflicts.json)
  compare <hashA> <hashB>       Print causal relation: happens-before | happens-after | equal | concurrent
  show <hash>                   Print a stored version
  list                          List all stored version hashes

Exit codes: 0 success, 1 validation/usage error, 2 merge contradiction (no merge commit created)
`;

function parseArgs(argv) {
  const positional = [];
  const flags = {};
  for (let i = 0; i < argv.length; i++) {
    if (argv[i].startsWith('--')) {
      const key = argv[i].slice(2);
      if (i + 1 < argv.length && !argv[i + 1].startsWith('--')) {
        flags[key] = argv[++i];
      } else {
        flags[key] = true;
      }
    } else {
      positional.push(argv[i]);
    }
  }
  return { positional, flags };
}

// run(argv, io) -> exit code. io defaults to process stdout/stderr.
function run(argv, io = {}) {
  const stdout = io.stdout || ((s) => process.stdout.write(s));
  const stderr = io.stderr || ((s) => process.stderr.write(s));
  const fail = (message) => {
    stderr(`error: ${message}\n`);
    return 1;
  };

  const { positional, flags } = parseArgs(argv);
  const command = positional[0];
  if (!command || command === 'help' || flags.help) {
    stdout(USAGE);
    return command ? 0 : 1;
  }
  const store = new Store(flags.store || '.lineage');

  try {
    switch (command) {
      case 'add': {
        const file = positional[1];
        if (!file) return fail('add requires a version JSON file');
        const version = JSON.parse(fs.readFileSync(file, 'utf8'));
        const hash = store.put(version);
        if (version.hash !== undefined && version.hash !== hash) {
          return fail(`hash mismatch: provided ${version.hash}, computed ${hash}`);
        }
        stdout(hash + '\n');
        return 0;
      }
      case 'merge': {
        const [hashA, hashB] = positional.slice(1);
        if (!hashA || !hashB) return fail('merge requires two version hashes');
        const options = {};
        if (flags['exclusive-groups']) {
          options.exclusiveGroups = JSON.parse(flags['exclusive-groups']);
        } else {
          options.exclusiveGroups = DEFAULT_EXCLUSIVE_GROUPS;
        }
        const result = mergeVersions(store, hashA, hashB, options);
        if (result.status === 'conflict') {
          const certificate = {
            type: 'pairwise-conflicts',
            versions: result.versions,
            conflicts: result.conflicts,
          };
          const outPath = flags.conflicts || 'pairwise-conflicts.json';
          fs.writeFileSync(outPath, JSON.stringify(certificate, null, 2) + '\n');
          stderr(
            `merge contradiction: ${result.conflicts.length} conflict(s); `
            + `certificate written to ${path.resolve(outPath)}\n`,
          );
          return 2;
        }
        stdout(JSON.stringify(result, null, 2) + '\n');
        return 0;
      }
      case 'compare': {
        const [hashA, hashB] = positional.slice(1);
        if (!hashA || !hashB) return fail('compare requires two version hashes');
        const a = store.get(hashA);
        const b = store.get(hashB);
        const cmp = vclock.compare(a.clock, b.clock);
        const relation = cmp === vclock.LESS ? 'happens-before'
          : cmp === vclock.GREATER ? 'happens-after'
          : cmp === vclock.EQUAL ? 'equal' : 'concurrent';
        stdout(relation + '\n');
        return 0;
      }
      case 'show': {
        const hash = positional[1];
        if (!hash) return fail('show requires a version hash');
        stdout(JSON.stringify(store.get(hash), null, 2) + '\n');
        return 0;
      }
      case 'list': {
        for (const hash of store.list()) stdout(hash + '\n');
        return 0;
      }
      default:
        stderr(`unknown command "${command}"\n\n${USAGE}`);
        return 1;
    }
  } catch (err) {
    if (err instanceof LineageError) {
      return fail(`${err.message} [${err.code}]`);
    }
    throw err;
  }
}

if (require.main === module) {
  process.exit(run(process.argv.slice(2)));
}

module.exports = { run };
