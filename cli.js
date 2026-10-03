#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import { Engine, rankDiff } from './src/engine.js';

function readOps(source) {
  const text = source === '-' ? readFileSync(0, 'utf8') : readFileSync(source, 'utf8');
  const parsed = JSON.parse(text);
  return Array.isArray(parsed) ? parsed : parsed.ops;
}

function parseId(raw) {
  try {
    return JSON.parse(raw);
  } catch {
    return raw;
  }
}

function fail(error, code = 1) {
  process.stderr.write(JSON.stringify({ error }) + '\n');
  process.exit(code);
}

function usage() {
  fail(
    'usage: node cli.js replay <ops.json|-> | certificate <ops.json|-> <hypothesisId> | diff <opsA.json> <opsB.json>',
    2,
  );
}

function main() {
  const [command, ...args] = process.argv.slice(2);
  if (!command) usage();

  if (command === 'replay') {
    if (args.length !== 1) usage();
    const engine = new Engine();
    const report = engine.replay(readOps(args[0]));
    const out = {
      ranking: engine.ranking.map((entry) => ({
        rank: entry.rank,
        hypothesis: entry.id,
        score: entry.score,
      })),
      excluded: engine.excluded,
      certificates: engine.certificates(),
      report,
    };
    process.stdout.write(JSON.stringify(out, null, 2) + '\n');
    return;
  }

  if (command === 'certificate') {
    if (args.length !== 2) usage();
    const engine = new Engine();
    engine.replay(readOps(args[0]));
    const certificate = engine.certificate(parseId(args[1]));
    if (certificate.error) fail(certificate);
    process.stdout.write(JSON.stringify(certificate, null, 2) + '\n');
    return;
  }

  if (command === 'diff') {
    if (args.length !== 2) usage();
    const engineA = new Engine();
    engineA.replay(readOps(args[0]));
    const engineB = new Engine();
    engineB.replay(readOps(args[1]));
    process.stdout.write(
      JSON.stringify({ changes: rankDiff(engineA.ranking, engineB.ranking) }, null, 2) + '\n',
    );
    return;
  }

  usage();
}

try {
  main();
} catch (err) {
  fail(err.message);
}
