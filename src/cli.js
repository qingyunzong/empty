#!/usr/bin/env node
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { loadRepo, RepoError } = require('./repo');
const { rebase } = require('./rebase');
const { ConflictError } = require('./patch');

const USAGE = `usage: node src/cli.js rebase --repo <repo.json> --branch <name> --onto <name> --outdir <dir>

Rebases the commits of <branch> that are not ancestors of <onto> onto the tip
of <onto>. On success writes <outdir>/rebased.json and <outdir>/mapping.json.
On any error (cyclic ancestry, broken parent chain, duplicate experiment
numbers, context conflict) nothing is written and the exit code is 1.`;

function parseArgs(argv) {
  const args = { _: [] };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg.startsWith('--')) {
      const key = arg.slice(2);
      const value = argv[i + 1];
      if (value === undefined || value.startsWith('--')) {
        throw new RepoError(`missing value for --${key}`);
      }
      args[key] = value;
      i += 1;
    } else {
      args._.push(arg);
    }
  }
  return args;
}

function writeAtomic(file, contents) {
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, contents);
  fs.renameSync(tmp, file);
}

function run(argv) {
  const args = parseArgs(argv);
  const command = args._[0];
  if (command !== 'rebase') {
    process.stderr.write(`${USAGE}\n`);
    return command === undefined ? 1 : 1;
  }
  for (const key of ['repo', 'branch', 'onto', 'outdir']) {
    if (!args[key]) {
      process.stderr.write(`error: missing required --${key}\n${USAGE}\n`);
      return 1;
    }
  }
  try {
    const repo = loadRepo(args.repo);
    const result = rebase(repo, args.branch, args.onto);

    const numbers = {};
    for (const entry of Object.values(result.mapping)) {
      numbers[String(entry.number)] = entry.newHash;
    }
    const rebasedJson = JSON.stringify(
      { onto: result.onto, tip: result.tip, commits: result.commits },
      null,
      2,
    );
    const mappingJson = JSON.stringify(
      { commits: result.mapping, numbers },
      null,
      2,
    );

    // Everything is computed before anything is written, so a conflict or
    // structural error can never leave partial new history behind.
    fs.mkdirSync(args.outdir, { recursive: true });
    writeAtomic(path.join(args.outdir, 'rebased.json'), `${rebasedJson}\n`);
    writeAtomic(path.join(args.outdir, 'mapping.json'), `${mappingJson}\n`);

    const collapsed = Object.values(result.mapping).filter((m) => m.collapsed).length;
    process.stdout.write(
      `rebased ${result.commits.length} commit(s) onto ${result.onto}` +
        (collapsed ? ` (${collapsed} empty commit(s) collapsed)` : '') +
        `\nnew tip: ${result.tip}\n`,
    );
    return 0;
  } catch (err) {
    if (err instanceof ConflictError) {
      process.stderr.write(`conflict: ${err.message}\n`);
      return 1;
    }
    if (err instanceof RepoError) {
      process.stderr.write(`error: ${err.message}\n`);
      return 1;
    }
    throw err;
  }
}

if (require.main === module) {
  // Use exitCode (not process.exit) so buffered stderr/stdout writes to
  // pipes are flushed before the process exits.
  process.exitCode = run(process.argv.slice(2));
}

module.exports = { run };
