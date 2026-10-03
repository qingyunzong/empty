#!/usr/bin/env node
import fs from 'node:fs';
import { Store } from './src/store.js';
import { QError } from './src/errors.js';
import { verifyProof } from './src/proof.js';

function parseArgs(argv) {
  const opts = {};
  const positional = [];
  for (let i = 0; i < argv.length; i++) {
    if (argv[i].startsWith('--')) opts[argv[i].slice(2)] = argv[++i];
    else positional.push(argv[i]);
  }
  return { opts, positional };
}

function usage() {
  console.error(`usage:
  qcert put     --data DIR [--id ID] [--text TEXT | --file F]
  qcert del     --data DIR --id ID
  qcert query   --data DIR --phrase "复验 合格"
  qcert prove   --data DIR --id ID
  qcert recover --data DIR
  qcert verify  --proof FILE [--phrase "复验 合格"]
fault injection: QCERT_FAULT=seg|pre-manifest|replace`);
  process.exit(64);
}

const { opts, positional } = parseArgs(process.argv.slice(2));
const cmd = positional[0];
if (!cmd) usage();

try {
  if (cmd === 'put') {
    const store = new Store(opts.data);
    const text = opts.text ?? fs.readFileSync(opts.file, 'utf8');
    const id = opts.id ?? `cert-${store.load().epoch + 1}`;
    const m = store.put(id, text);
    console.log(`put: id=${id} epoch=${m.epoch} head=${m.head}`);
  } else if (cmd === 'del') {
    const store = new Store(opts.data);
    const m = store.del(opts.id);
    console.log(`del: id=${opts.id} epoch=${m.epoch} head=${m.head}`);
  } else if (cmd === 'query') {
    const store = new Store(opts.data);
    const results = store.query(opts.phrase);
    if (results.length === 0) console.log('no match');
    for (const r of results) console.log(`match: ${r.id} positions=${r.positions.join(',')}`);
  } else if (cmd === 'prove') {
    const store = new Store(opts.data);
    console.log(JSON.stringify(store.prove(opts.id), null, 2));
  } else if (cmd === 'recover') {
    const store = new Store(opts.data);
    for (const line of store.recover()) console.log(line);
  } else if (cmd === 'verify') {
    const proof = JSON.parse(fs.readFileSync(opts.proof, 'utf8'));
    const r = verifyProof(proof, opts.phrase ?? null);
    const parts = [];
    if (r.exclusion) parts.push(`exclusion@${r.exclusion.epoch}`);
    if (r.inclusion) parts.push(`inclusion@${r.inclusion.epoch}`);
    console.log(`verify: ok ${parts.join(' ')}`);
  } else {
    usage();
  }
} catch (e) {
  if (e instanceof QError) {
    console.error(`${e.code}: ${e.message}`);
    process.exit(1);
  }
  throw e;
}
