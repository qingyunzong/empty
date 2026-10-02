import { readFileSync, writeFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { rewriteHistory, RewriteAbort, IntegrityError } from './redact.js';
import { verifyHistory } from './history.js';

export const USAGE = `Usage:
  history-redact rewrite --history <file> --rules <file> [--out-history <file>] [--out-manifest <file>]
  history-redact verify  --history <file>

Commands:
  rewrite   Redact sensitive values, rewrite all commit hashes, and write the
            rewritten history plus a rewrite manifest (old->new hash mapping,
            token map, old-history invalidation proof).
  verify    Replay a history and check every recorded commit hash.

Exit codes:
  0  success
  1  usage error, I/O error, or history integrity failure
  2  rewrite aborted (token collision, unlocatable patch context, or
     projection mismatch); original files are left untouched
`;

function parseArgs(argv) {
  const args = { _: [] };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg.startsWith('--')) {
      const key = arg.slice(2);
      const next = argv[i + 1];
      if (next === undefined || next.startsWith('--')) {
        throw new Error(`missing value for --${key}`);
      }
      args[key] = next;
      i += 1;
    } else {
      args._.push(arg);
    }
  }
  return args;
}

function readJson(path) {
  return JSON.parse(readFileSync(path, 'utf8'));
}

function loadCommits(path) {
  const doc = readJson(path);
  if (Array.isArray(doc)) return doc;
  if (doc && Array.isArray(doc.commits)) return doc.commits;
  throw new Error(`${path}: expected an array of commits or { "commits": [...] }`);
}

function defaultOutPath(historyPath, suffix) {
  const dir = dirname(historyPath);
  const base = basename(historyPath).replace(/\.json$/i, '');
  return join(dir, `${base}.${suffix}.json`);
}

// Runs the CLI. `io` may capture output in tests; returns the exit code.
export function run(argv, io = {}) {
  const out = io.stdout ?? ((line) => console.log(line));
  const err = io.stderr ?? ((line) => console.error(line));
  try {
    const args = parseArgs(argv);
    const command = args._[0];

    if (command === 'verify') {
      if (!args.history) throw new Error('verify requires --history');
      const commits = loadCommits(args.history);
      const problems = verifyHistory(commits);
      if (problems.length > 0) {
        for (const p of problems) err(`integrity: ${p}`);
        return 1;
      }
      out(`OK: ${commits.length} commit(s) replayed, all hashes match the specification`);
      return 0;
    }

    if (command === 'rewrite') {
      if (!args.history) throw new Error('rewrite requires --history');
      if (!args.rules) throw new Error('rewrite requires --rules');
      const commits = loadCommits(args.history);
      const rules = readJson(args.rules);
      if (!Array.isArray(rules)) throw new Error(`${args.rules}: expected an array of rules`);

      // Nothing is written before the rewrite completes successfully, so an
      // abort leaves the original files untouched.
      const result = rewriteHistory(commits, rules);

      const outHistory = args['out-history'] ?? defaultOutPath(args.history, 'rewritten');
      const outManifest = args['out-manifest'] ?? defaultOutPath(args.history, 'manifest');
      writeFileSync(outHistory, JSON.stringify({ format: 'history-redact/history/1', commits: result.commits }, null, 2) + '\n');
      writeFileSync(outManifest, JSON.stringify(result.manifest, null, 2) + '\n');
      out(`rewrote ${result.commits.length} commit(s)`);
      out(`  old tip: ${result.manifest.oldTip}`);
      out(`  new tip: ${result.manifest.newTip}`);
      out(`  tokens:  ${result.tokenMap.length} sensitive value(s) redacted`);
      out(`  history: ${outHistory}`);
      out(`  manifest: ${outManifest}`);
      return 0;
    }

    err(USAGE);
    return command === undefined || command === 'help' ? 0 : 1;
  } catch (error) {
    if (error instanceof RewriteAbort) {
      err(`abort (${error.reason}): ${error.message}`);
      err('original files left untouched');
      return 2;
    }
    if (error instanceof IntegrityError) {
      err(`integrity error: ${error.message}`);
      return 1;
    }
    err(`error: ${error.message}`);
    return 1;
  }
}
