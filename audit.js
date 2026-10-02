#!/usr/bin/env node
'use strict';
// audit build --in entries.jsonl --out out.json [--proof proof.json] [--as-of N] [--incremental]
// audit verify <out.json> <proof.json>

const fs = require('node:fs');
const path = require('node:path');
const {
  EXIT,
  AuditError,
  buildFull,
  buildIncremental,
  renderOutput,
  renderProof,
  verifyProof,
} = require('./src/audit');

const BOOLEAN_FLAGS = new Set(['incremental']);

function parseArgs(argv) {
  const flags = {};
  const positional = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const name = a.slice(2);
      if (BOOLEAN_FLAGS.has(name)) {
        flags[name] = true;
      } else {
        if (i + 1 >= argv.length) throw new AuditError('E_PARSE', `flag --${name} needs a value`);
        flags[name] = argv[++i];
      }
    } else {
      positional.push(a);
    }
  }
  return { flags, positional };
}

function cmdBuild(flags) {
  if (!flags.in || !flags.out) {
    throw new AuditError('E_PARSE', 'build requires --in <entries.jsonl> and --out <out.json>');
  }
  const proofPath = flags.proof || 'proof.json';
  const asOf = flags['as-of'] === undefined ? null : Number(flags['as-of']);
  if (asOf !== null && (!Number.isInteger(asOf) || asOf < 0)) {
    throw new AuditError('E_PARSE', `--as-of must be a non-negative integer, got "${flags['as-of']}"`);
  }
  const content = fs.readFileSync(flags.in, 'utf8');

  let result;
  const prevPath = flags['prev-proof'] || (fs.existsSync(proofPath) ? proofPath : null);
  if (flags.incremental && prevPath) {
    const prevProof = JSON.parse(fs.readFileSync(prevPath, 'utf8'));
    result = buildIncremental(flags.in, content, asOf, prevProof);
  } else {
    result = buildFull(flags.in, content, asOf);
  }

  const outText = renderOutput(result.proof);
  fs.writeFileSync(flags.out, outText);
  result.proof.outputHash = require('./src/audit').sha256tag(outText);
  fs.writeFileSync(proofPath, renderProof(result.proof));

  const cats = Object.keys(result.proof.categories);
  const inc = result.proof.meta.incremental;
  process.stdout.write(
    `built: asOf=${result.proof.asOf} categories=${cats.length} rootHash=${result.proof.rootHash}\n`
  );
  if (inc && !inc.fallback) {
    process.stdout.write(
      `incremental: recomputed=[${inc.affectedCategories}] reused=[${inc.reusedCategories}]\n`
    );
  } else if (inc && inc.fallback) {
    process.stdout.write(`incremental: fallback to full rebuild (${inc.reason})\n`);
  }
}

function resolveInputPath(recorded, proofPath) {
  if (path.isAbsolute(recorded)) return recorded;
  if (fs.existsSync(recorded)) return recorded;
  const rel = path.join(path.dirname(proofPath), recorded);
  if (fs.existsSync(rel)) return rel;
  return recorded; // let readFileSync throw a clear error
}

function cmdVerify(positional) {
  const [outPath, proofPath] = positional;
  if (!outPath || !proofPath) {
    throw new AuditError('E_PARSE', 'verify requires <out.json> and <proof.json>');
  }
  const proof = JSON.parse(fs.readFileSync(proofPath, 'utf8'));
  const inputPath = resolveInputPath(proof.input, proofPath);
  const inputContent = fs.readFileSync(inputPath, 'utf8');
  const outputBytes = fs.readFileSync(outPath);
  verifyProof(inputContent, outputBytes, proof);
  process.stdout.write(`OK: proof verified (asOf=${proof.asOf}, rootHash=${proof.rootHash})\n`);
}

function main() {
  const [, , cmd, ...rest] = process.argv;
  try {
    if (cmd === 'build') {
      cmdBuild(parseArgs(rest).flags);
    } else if (cmd === 'verify') {
      cmdVerify(parseArgs(rest).positional);
    } else {
      process.stderr.write('usage: audit build --in f --out o [--proof p] [--as-of N] [--incremental [--prev-proof p0]]\n');
      process.stderr.write('       audit verify <out.json> <proof.json>\n');
      process.exit(EXIT.GENERIC);
    }
  } catch (e) {
    if (e instanceof AuditError) {
      process.stderr.write(`${e.code}: ${e.message}\n`);
      process.exit(EXIT[e.code] ?? EXIT.GENERIC);
    }
    process.stderr.write(`E_GENERIC: ${e.message}\n`);
    process.exit(EXIT.GENERIC);
  }
}

main();
