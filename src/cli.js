#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { Store } from './store.js';
import { ProvError } from './errors.js';

const USAGE = `usage:
  provq exec <query.json> <dataDir>     execute query, capture lineage, write proofs
  provq prove <outKey>                  verify and show the proof for one output row
  provq correct <table> <key> <patch>   apply a JSON merge patch to one input row
  provq reverify <outKey> | --all       incrementally re-verify, emit a certificate
  provq explain [outKey]                show lineage / state summary
options:
  --state <dir>                         state directory (default: $PROV_STATE or ./.prov)`;

function parseArgs(argv) {
  const args = [...argv];
  let stateDir = process.env.PROV_STATE ?? '.prov';
  for (let i = 0; i < args.length; i += 1) {
    if (args[i] === '--state') {
      if (!args[i + 1]) throw new Error('--state requires a directory');
      stateDir = args[i + 1];
      args.splice(i, 2);
      i -= 1;
    }
  }
  return { args, stateDir };
}

export function run(argv) {
  const { args, stateDir } = parseArgs(argv);
  const [cmd, ...rest] = args;
  const store = new Store(stateDir);
  switch (cmd) {
    case 'exec': {
      const [queryPath, dataDir] = rest;
      if (!queryPath || !dataDir) throw new Error(USAGE);
      const query = JSON.parse(fs.readFileSync(queryPath, 'utf8'));
      const { outputs, manifest } = store.exec(query, dataDir);
      const partials = outputs.filter((o) => o.provenance.partial);
      return {
        ok: true,
        command: 'exec',
        generation: manifest.generation,
        outputCount: outputs.length,
        outputs: outputs.map((o) => ({
          outKey: o.outKey,
          row: o.row,
          partial: o.provenance.partial,
          contributorCount: o.provenance.contributors.length,
        })),
        partials: partials.map((o) => ({
          outKey: o.outKey,
          unknowns: o.provenance.unknowns,
        })),
      };
    }
    case 'prove': {
      const [outKey] = rest;
      if (!outKey) throw new Error(USAGE);
      const proof = store.prove(outKey);
      return {
        ok: true,
        command: 'prove',
        outKey,
        generation: proof.generation,
        partial: proof.provenance.partial,
        unknowns: proof.provenance.unknowns,
        proof,
      };
    }
    case 'correct': {
      const [table, key, patchText] = rest;
      if (!table || key === undefined || !patchText) throw new Error(USAGE);
      const patch = JSON.parse(patchText);
      const result = store.correct(table, key, patch);
      return { ok: true, command: 'correct', table, key, ...result };
    }
    case 'reverify': {
      const [outKey] = rest;
      if (!outKey) throw new Error(USAGE);
      if (outKey === '--all') {
        return { ok: true, command: 'reverify', ...store.reverifyAll() };
      }
      return { ok: true, command: 'reverify', certificate: store.reverify(outKey) };
    }
    case 'explain': {
      const [outKey] = rest;
      return { ok: true, command: 'explain', ...store.explain(outKey) };
    }
    default:
      throw new Error(USAGE);
  }
}

const isMain =
  process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;

if (isMain) {
  try {
    const result = run(process.argv.slice(2));
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  } catch (err) {
    if (err instanceof ProvError) {
      process.stderr.write(`error ${err.code}: ${err.message}\n`);
      if (err.details !== undefined) process.stderr.write(`${JSON.stringify(err.details)}\n`);
      process.exit(1);
    }
    process.stderr.write(`error: ${err.message}\n`);
    process.exit(2);
  }
}
