#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { ExitError } from './src/errors.js';
import { loadRecipesFile } from './src/recipes.js';
import { validateApprovals } from './src/approvals.js';
import { validateAttempts, runAll, computeDeviations, buildProofs } from './src/audit.js';
import { minimalAllowSet } from './src/counterexample.js';

const USAGE = `usage:
  node cli.js run  --recipes R.json --approvals A.jsonl --attempts T.jsonl --out allow.jsonl --proof DIR
  node cli.js audit --recipes R.json --approvals A.jsonl --attempts T.jsonl --allow allow.jsonl --proof DIR
  node cli.js counterexample --recipes R.json --approvals A.jsonl --attempts T.jsonl [--attempt ID]

exit codes: 0 ok | 1 audit mismatch | 2 invalid input | 16 version rollback | 17 approval chain broken | 18 forbidden table cycle`;

function parseFlags(argv) {
  const flags = {};
  for (let i = 0; i < argv.length; i++) {
    if (argv[i].startsWith('--')) {
      const key = argv[i].slice(2);
      flags[key] = i + 1 < argv.length && !argv[i + 1].startsWith('--') ? argv[++i] : true;
    }
  }
  return flags;
}

function readJsonl(p) {
  let text;
  try {
    text = fs.readFileSync(p, 'utf8');
  } catch (e) {
    throw new ExitError(2, `cannot read ${p}: ${e.message}`);
  }
  return text
    .split('\n')
    .map((l, i) => ({ l, i }))
    .filter(({ l }) => l.trim() !== '')
    .map(({ l, i }) => {
      try {
        return JSON.parse(l);
      } catch {
        throw new ExitError(2, `${p}:${i + 1} invalid JSON`);
      }
    });
}

function requireFlag(flags, name) {
  if (typeof flags[name] !== 'string') throw new ExitError(2, `missing --${name}`);
  return flags[name];
}

function loadInputs(flags) {
  const recipes = loadRecipesFile(requireFlag(flags, 'recipes'));
  const approvals = readJsonl(requireFlag(flags, 'approvals'));
  validateApprovals(approvals, recipes);
  const attempts = readJsonl(requireFlag(flags, 'attempts'));
  validateAttempts(attempts, recipes);
  return { recipes, approvals, attempts };
}

function computeAll(recipes, approvals, attempts) {
  const { results } = runAll(recipes, approvals, attempts);
  const deviations = computeDeviations(approvals, results);
  const proofs = buildProofs(recipes, results);
  const counterexamples = [];
  for (const r of results) {
    if (r.decision === 'deny' && r.conflictWith) {
      const attempt = attempts.find((t) => t.id === r.attempt);
      counterexamples.push({
        attempt: r.attempt,
        kettle: r.kettle,
        version: r.version,
        conflictWith: r.conflictWith,
        minimalAllowSet: minimalAllowSet(recipes, approvals, attempt),
      });
    }
  }
  return { results, deviations, proofs, counterexamples };
}

function writeOutputs(outPath, proofDir, data) {
  fs.writeFileSync(outPath, data.results.map((r) => JSON.stringify(r)).join('\n') + '\n');
  fs.mkdirSync(proofDir, { recursive: true });
  for (const [kettle, proof] of data.proofs) {
    fs.writeFileSync(path.join(proofDir, `kettle-${kettle}.json`), JSON.stringify(proof, null, 2) + '\n');
  }
  fs.writeFileSync(path.join(proofDir, 'deviations.json'), JSON.stringify(data.deviations, null, 2) + '\n');
  fs.writeFileSync(
    path.join(proofDir, 'counterexample.json'),
    JSON.stringify(data.counterexamples, null, 2) + '\n',
  );
}

function cmdRun(flags, io) {
  const { recipes, approvals, attempts } = loadInputs(flags);
  const data = computeAll(recipes, approvals, attempts);
  const out = requireFlag(flags, 'out');
  const proofDir = requireFlag(flags, 'proof');
  writeOutputs(out, proofDir, data);
  const allowed = data.results.filter((r) => r.decision === 'allow').length;
  const denied = data.results.length - allowed;
  io.stdout(`decisions: ${allowed} allowed, ${denied} denied`);
  io.stdout(`deviations: ${data.deviations.length}, counterexamples: ${data.counterexamples.length}`);
  io.stdout(`wrote ${out} and ${proofDir}/`);
  return 0;
}

function cmdAudit(flags, io) {
  const { recipes, approvals, attempts } = loadInputs(flags);
  const data = computeAll(recipes, approvals, attempts);
  const problems = [];

  const allowPath = requireFlag(flags, 'allow');
  const proofDir = requireFlag(flags, 'proof');
  const recorded = readJsonl(allowPath);
  if (JSON.stringify(recorded) !== JSON.stringify(data.results)) {
    problems.push('allow.jsonl does not match replay');
  }
  if (!fs.existsSync(proofDir)) {
    problems.push(`proof dir ${proofDir} missing`);
  } else {
    const expectedFiles = new Set(['deviations.json', 'counterexample.json']);
    for (const [kettle, proof] of data.proofs) {
      const name = `kettle-${kettle}.json`;
      expectedFiles.add(name);
      const p = path.join(proofDir, name);
      if (!fs.existsSync(p)) {
        problems.push(`missing proof file ${name}`);
      } else if (JSON.stringify(JSON.parse(fs.readFileSync(p, 'utf8'))) !== JSON.stringify(proof)) {
        problems.push(`proof mismatch for kettle ${kettle}`);
      }
    }
    for (const [name, expected] of [
      ['deviations.json', data.deviations],
      ['counterexample.json', data.counterexamples],
    ]) {
      const p = path.join(proofDir, name);
      if (!fs.existsSync(p)) {
        problems.push(`missing ${name}`);
      } else if (JSON.stringify(JSON.parse(fs.readFileSync(p, 'utf8'))) !== JSON.stringify(expected)) {
        problems.push(`${name} does not match replay`);
      }
    }
    for (const f of fs.readdirSync(proofDir)) {
      if (!expectedFiles.has(f)) problems.push(`unexpected file in proof dir: ${f}`);
    }
  }
  if (problems.length > 0) {
    for (const p of problems) io.stderr(`audit failed: ${p}`);
    return 1;
  }
  const feeds = data.results.filter((r) => r.decision === 'allow').length;
  io.stdout(`audit ok: ${feeds} feeds verified across ${data.proofs.size} kettle(s), ${data.deviations.length} deviation(s)`);
  return 0;
}

function cmdCounterexample(flags, io) {
  const { recipes, approvals, attempts } = loadInputs(flags);
  const targets = flags.attempt ? attempts.filter((t) => t.id === flags.attempt) : attempts;
  if (targets.length === 0) throw new ExitError(2, `no such attempt ${flags.attempt}`);
  const out = targets.map((t) => ({
    attempt: t.id,
    kettle: t.kettle,
    version: t.version,
    minimalAllowSet: minimalAllowSet(recipes, approvals, t),
  }));
  io.stdout(JSON.stringify(out, null, 2));
  return 0;
}

// Programmatic entry: returns the exit code, writes through io.{stdout,stderr}.
export function main(argv, io = { stdout: (s) => console.log(s), stderr: (s) => console.error(s) }) {
  const [cmd, ...rest] = argv;
  const flags = parseFlags(rest);
  try {
    if (cmd === 'run') return cmdRun(flags, io);
    if (cmd === 'audit') return cmdAudit(flags, io);
    if (cmd === 'counterexample') return cmdCounterexample(flags, io);
    io.stderr(USAGE);
    return 2;
  } catch (e) {
    if (e instanceof ExitError) {
      io.stderr(`error: ${e.message}`);
      return e.exitCode;
    }
    throw e;
  }
}

const invokedAsScript = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (invokedAsScript) {
  process.exitCode = main(process.argv.slice(2));
}
