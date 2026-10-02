#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const store = require('./lib/store');

function parseArgs(argv) {
  const args = { _: [] };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const key = a.slice(2);
      if (i + 1 < argv.length && !argv[i + 1].startsWith('--')) {
        args[key] = argv[i + 1];
        i += 1;
      } else {
        args[key] = true;
      }
    } else {
      args._.push(a);
    }
  }
  return args;
}

function requireOpt(args, name) {
  if (!args[name]) throw new Error(`missing required option --${name}`);
  return args[name];
}

function readStateFile(file) {
  const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (!parsed || typeof parsed !== 'object' || typeof parsed.accounts !== 'object') {
    throw new Error(`state file must be {"accounts": {...}}: ${file}`);
  }
  return { accounts: parsed.accounts };
}

function cmdSnapshot(args) {
  const storeDir = requireOpt(args, 'store');
  let state;
  if (args.state) {
    state = readStateFile(args.state);
  } else {
    state = store.restore(storeDir).state;
  }
  const manifest = store.writeSnapshot(storeDir, state, {
    chunkSize: args['chunk-size'] ? parseInt(args['chunk-size'], 10) : undefined,
    crashPoint: args['crash-point'] || null,
  });
  process.stdout.write(JSON.stringify({ snapshot: manifest }, null, 2) + '\n');
}

function cmdDelta(args) {
  const storeDir = requireOpt(args, 'store');
  let ops;
  if (args.ops) {
    ops = JSON.parse(args.ops);
  } else if (args.file) {
    ops = JSON.parse(fs.readFileSync(args.file, 'utf8'));
  } else {
    throw new Error('delta requires --ops <json> or --file <path>');
  }
  if (!Array.isArray(ops)) ops = [ops];
  const entry = store.appendDelta(storeDir, ops);
  process.stdout.write(JSON.stringify({ delta: entry }, null, 2) + '\n');
}

function cmdRestore(args) {
  const storeDir = requireOpt(args, 'store');
  const result = store.restore(storeDir);
  const out = {
    trustedPoint: result.trustedPoint,
    appliedThrough: result.appliedThrough,
    finalStateHash: result.finalStateHash,
    state: result.state,
  };
  const text = JSON.stringify(out, null, 2) + '\n';
  if (args.out) {
    fs.writeFileSync(args.out, text);
    process.stdout.write(JSON.stringify({ written: path.resolve(args.out), trustedPoint: out.trustedPoint, finalStateHash: out.finalStateHash }, null, 2) + '\n');
  } else {
    process.stdout.write(text);
  }
}

function cmdCheck(args) {
  const storeDir = requireOpt(args, 'store');
  if (args.verify) {
    const expected = JSON.parse(fs.readFileSync(args.verify, 'utf8'));
    const { proof } = store.buildProof(storeDir);
    const recomputed = store.sha256(store.canonical(Object.fromEntries(
      Object.entries(proof).filter(([k]) => k !== 'proofHash')
    )));
    const ok = recomputed === expected.proofHash && store.canonical(proof) === store.canonical(expected);
    process.stdout.write(JSON.stringify({ verified: ok, proofHash: proof.proofHash, expectedProofHash: expected.proofHash }, null, 2) + '\n');
    process.exit(ok ? 0 : 1);
    return;
  }
  const { proof, firstError } = store.buildProof(storeDir);
  const text = JSON.stringify(proof, null, 2) + '\n';
  if (args.proof) fs.writeFileSync(args.proof, text);
  process.stdout.write(text);
  if (firstError) {
    process.stderr.write(JSON.stringify({ error: firstError.message, code: firstError.code }) + '\n');
    process.exit(firstError.code || 1);
  }
}

function main() {
  const [command, ...rest] = process.argv.slice(2);
  const args = parseArgs(rest);
  try {
    switch (command) {
      case 'snapshot': return cmdSnapshot(args);
      case 'delta': return cmdDelta(args);
      case 'restore': return cmdRestore(args);
      case 'check': return cmdCheck(args);
      default:
        process.stderr.write('usage: node cli.js snapshot|delta|restore|check --store DIR [options]\n');
        process.exit(2);
    }
  } catch (err) {
    const code = typeof err.code === 'number' ? err.code : 1;
    process.stderr.write(JSON.stringify({ error: err.message, code }) + '\n');
    process.exit(code);
  }
}

main();
