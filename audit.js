#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const EXIT_OK = 0;
const EXIT_USAGE = 1;
const EXIT_FUTURE_CORRECTION = 2;
const EXIT_PROOF = 3;

class AuditError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

function printStdout(message) {
  fs.writeSync(1, message);
}

function printStderr(message) {
  fs.writeSync(2, message);
}

function sha256(data) {
  return crypto.createHash('sha256').update(data).digest('hex');
}

function canonical(value) {
  if (value === null) return 'null';
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new AuditError('E_PARSE', 'non-finite number');
    return JSON.stringify(value);
  }
  if (typeof value === 'string') return JSON.stringify(value);
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
  if (typeof value === 'object') {
    const keys = Object.keys(value).sort();
    return '{' + keys.map((k) => JSON.stringify(k) + ':' + canonical(value[k])).join(',') + '}';
  }
  throw new AuditError('E_PARSE', 'unsupported value type: ' + typeof value);
}

function parseEntries(text) {
  const rows = [];
  const lines = text.split('\n');
  let seq = 0;
  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line) continue;
    seq += 1;
    let obj;
    try {
      obj = JSON.parse(line);
    } catch {
      throw new AuditError('E_PARSE', `line ${seq}: invalid JSON`);
    }
    if (obj === null || typeof obj !== 'object' || Array.isArray(obj)) {
      throw new AuditError('E_PARSE', `line ${seq}: entry must be a JSON object`);
    }
    const amount = obj.amount === undefined || obj.amount === null ? null : Number(obj.amount);
    if (amount !== null && !Number.isFinite(amount)) {
      throw new AuditError('E_PARSE', `line ${seq}: amount is not a finite number`);
    }
    rows.push({
      seq,
      id: obj.id === undefined || obj.id === null ? `row${seq}` : String(obj.id),
      account: obj.account === undefined || obj.account === null ? null : String(obj.account),
      amount,
      category: obj.category === undefined || obj.category === null ? '' : String(obj.category),
      valid: obj.valid === undefined ? true : Boolean(obj.valid),
      corrects: obj.corrects === undefined || obj.corrects === null ? null : String(obj.corrects),
    });
  }
  const seen = new Set();
  for (const row of rows) {
    if (row.corrects !== null && !seen.has(row.corrects)) {
      throw new AuditError(
        'E_FUTURE_CORRECTION',
        `row ${row.seq} (${row.id}) corrects unknown or future id "${row.corrects}"`
      );
    }
    seen.add(row.id);
  }
  return rows;
}

function leafHash(row) {
  return sha256(canonical(row));
}

function buildExpression(asof) {
  const asofPred = asof === null ? '' : ` ^ seq<=${asof}`;
  return (
    'project[category,sum,count](' +
    'group_by[category; sum=sum(amount), count=count(*)](' +
    `select[valid=true and supersededBy=null${asofPred}](entries)))`
  );
}

function scopeRows(rows, asof) {
  if (asof === null) return rows.slice();
  return rows.filter((r) => r.seq <= asof);
}

function computeSuperseded(scoped) {
  const superseded = new Set();
  for (const row of scoped) {
    if (row.corrects !== null) superseded.add(row.corrects);
  }
  return superseded;
}

function aggregateCategory(category, members) {
  let sum = 0;
  let count = 0;
  const leafHashes = [];
  for (const row of members) {
    sum += row.amount === null ? 0 : row.amount;
    count += 1;
    leafHashes.push(leafHash(row));
  }
  const digest = sha256(canonical({ category, count, leaves: leafHashes, sum }));
  return { category, sum, count, leafHashes, digest };
}

function planAggregation(scoped) {
  const superseded = computeSuperseded(scoped);
  const leaves = scoped.map((row) => ({
    seq: row.seq,
    id: row.id,
    hash: leafHash(row),
    included: row.valid && !superseded.has(row.id),
    supersededBy: superseded.has(row.id)
      ? scoped.find((r) => r.corrects === row.id).id
      : null,
  }));
  const membersByCategory = new Map();
  for (const row of scoped) {
    if (!row.valid || superseded.has(row.id)) continue;
    if (!membersByCategory.has(row.category)) membersByCategory.set(row.category, []);
    membersByCategory.get(row.category).push(row);
  }
  return { superseded, leaves, membersByCategory };
}

function finalizeProof({ asof, inputHash, leaves, categoryEntries }) {
  const categories = categoryEntries
    .slice()
    .sort((a, b) => (a.category < b.category ? -1 : a.category > b.category ? 1 : 0));
  const root = sha256(canonical(categories.map((c) => c.digest)));
  const expression = buildExpression(asof);
  const proof = {
    version: 1,
    expression,
    asof,
    inputHash,
    leaves,
    categories,
    root,
  };
  const result = {
    asof,
    expression,
    root,
    categories: Object.fromEntries(
      categories.map((c) => [c.category, { sum: c.sum, count: c.count }])
    ),
  };
  return { proof, result };
}

function fullAggregate(rows, asof, inputHash) {
  const scoped = scopeRows(rows, asof);
  const { leaves, membersByCategory } = planAggregation(scoped);
  const categoryEntries = [];
  for (const [category, members] of membersByCategory) {
    categoryEntries.push(aggregateCategory(category, members));
  }
  return finalizeProof({ asof, inputHash, leaves, categoryEntries });
}

function incrementalAggregate(rows, asof, inputHash, prevDir) {
  if (asof !== null) {
    throw new AuditError('E_USAGE', '--incremental cannot be combined with --asof');
  }
  const prevProof = JSON.parse(fs.readFileSync(path.join(prevDir, 'proof.json'), 'utf8'));
  const prevSnapshot = fs.readFileSync(path.join(prevDir, 'input.snapshot.jsonl'), 'utf8');
  const prevRows = parseEntries(prevSnapshot);
  const prevById = new Map(prevRows.map((r) => [r.id, r]));
  const newById = new Map(rows.map((r) => [r.id, r]));

  const affected = new Set();
  for (const row of rows) {
    const prev = prevById.get(row.id);
    if (!prev) {
      affected.add(row.category);
      if (row.corrects !== null) {
        const target = prevById.get(row.corrects);
        if (target) affected.add(target.category);
      }
    } else if (canonical(prev) !== canonical(row)) {
      affected.add(prev.category);
      affected.add(row.category);
    }
  }
  for (const prev of prevRows) {
    if (!newById.has(prev.id)) affected.add(prev.category);
  }

  const scoped = scopeRows(rows, null);
  const { leaves, membersByCategory } = planAggregation(scoped);
  const prevCategories = new Map(prevProof.categories.map((c) => [c.category, c]));
  const categoryEntries = [];
  const allCategories = new Set([...membersByCategory.keys(), ...prevCategories.keys()]);
  for (const category of allCategories) {
    if (!affected.has(category) && prevCategories.has(category) && membersByCategory.has(category)) {
      categoryEntries.push(prevCategories.get(category));
    } else if (membersByCategory.has(category)) {
      categoryEntries.push(aggregateCategory(category, membersByCategory.get(category)));
    }
  }
  return finalizeProof({ asof, inputHash, leaves, categoryEntries });
}

function writeOutput(outDir, inputText, proof, result) {
  fs.mkdirSync(outDir, { recursive: true });
  fs.writeFileSync(path.join(outDir, 'input.snapshot.jsonl'), inputText);
  fs.writeFileSync(path.join(outDir, 'proof.json'), JSON.stringify(proof, null, 2) + '\n');
  fs.writeFileSync(path.join(outDir, 'result.json'), JSON.stringify(result, null, 2) + '\n');
}

function commandBuild(flags) {
  const inputPath = flags.in;
  const outDir = flags.out;
  if (!inputPath || !outDir) throw new AuditError('E_USAGE', 'build requires --in <file> and --out <dir>');
  const asof = flags.asof === undefined ? null : Number(flags.asof);
  if (asof !== null && (!Number.isInteger(asof) || asof < 0)) {
    throw new AuditError('E_USAGE', '--asof must be a non-negative integer');
  }
  const inputText = fs.readFileSync(inputPath, 'utf8');
  const rows = parseEntries(inputText);
  const inputHash = sha256(inputText);
  const { proof, result } = flags.incremental
    ? incrementalAggregate(rows, asof, inputHash, flags.prev || path.join(outDir))
    : fullAggregate(rows, asof, inputHash);
  writeOutput(outDir, inputText, proof, result);
  const mode = flags.incremental ? 'incremental' : 'full';
  printStdout(`build ok (${mode}): ${proof.categories.length} categories, root=${proof.root}\n`);
  return EXIT_OK;
}

function commandVerify(positional) {
  const [outDir, proofPath] = positional;
  if (!outDir || !proofPath) throw new AuditError('E_USAGE', 'verify requires <outDir> <proof.json>');
  try {
    const proof = JSON.parse(fs.readFileSync(proofPath, 'utf8'));
    const snapshotText = fs.readFileSync(path.join(outDir, 'input.snapshot.jsonl'), 'utf8');
    const resultOnDisk = JSON.parse(fs.readFileSync(path.join(outDir, 'result.json'), 'utf8'));

    const rows = parseEntries(snapshotText);
    const inputHash = sha256(snapshotText);
    const recomputed = fullAggregate(rows, proof.asof === undefined ? null : proof.asof, inputHash);

    const checks = [
      ['inputHash', proof.inputHash === inputHash],
      ['expression', proof.expression === recomputed.proof.expression],
      ['leaves', canonical(proof.leaves) === canonical(recomputed.proof.leaves)],
      ['categories', canonical(proof.categories) === canonical(recomputed.proof.categories)],
      ['root', proof.root === recomputed.proof.root],
      ['result.json', canonical(resultOnDisk) === canonical(recomputed.result)],
    ];
    const failed = checks.filter(([, ok]) => !ok).map(([name]) => name);
    if (failed.length > 0) {
      throw new AuditError('E_PROOF', `proof mismatch: ${failed.join(', ')}`);
    }
    printStdout(`verify ok: root=${proof.root}\n`);
    return EXIT_OK;
  } catch (err) {
    if (err instanceof AuditError && err.code === 'E_USAGE') throw err;
    if (err instanceof AuditError && err.code === 'E_PROOF') throw err;
    throw new AuditError('E_PROOF', `verification failed: ${err.message}`);
  }
}

function parseFlags(args) {
  const flags = {};
  const positional = [];
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === '--incremental') {
      flags.incremental = true;
    } else if (arg.startsWith('--')) {
      const key = arg.slice(2);
      const value = args[i + 1];
      if (value === undefined || value.startsWith('--')) {
        throw new AuditError('E_USAGE', `flag ${arg} requires a value`);
      }
      flags[key] = value;
      i += 1;
    } else {
      positional.push(arg);
    }
  }
  return { flags, positional };
}

function exitCodeFor(code) {
  switch (code) {
    case 'E_FUTURE_CORRECTION':
      return EXIT_FUTURE_CORRECTION;
    case 'E_PROOF':
      return EXIT_PROOF;
    default:
      return EXIT_USAGE;
  }
}

function main(argv) {
  const [command, ...rest] = argv;
  try {
    if (command === 'build') {
      const { flags } = parseFlags(rest);
      return commandBuild(flags);
    }
    if (command === 'verify') {
      const { positional } = parseFlags(rest);
      return commandVerify(positional);
    }
    throw new AuditError('E_USAGE', 'usage: audit build --in f --out o [--asof N] [--incremental --prev dir] | audit verify o proof.json');
  } catch (err) {
    if (err instanceof AuditError) {
      printStderr(`${err.code}: ${err.message}\n`);
      return exitCodeFor(err.code);
    }
    printStderr(`E_INTERNAL: ${err.message}\n`);
    return EXIT_USAGE;
  }
}

if (require.main === module) {
  process.exitCode = main(process.argv.slice(2));
}

module.exports = { parseEntries, fullAggregate, incrementalAggregate, canonical, sha256, main };
