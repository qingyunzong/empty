#!/usr/bin/env node
import fs from 'node:fs';
import { Genealogy, makeCorrection } from './src/genealogy.js';
import { GenealogyError } from './src/errors.js';

function parseArgs(argv) {
  const positional = [];
  const opts = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg.startsWith('--')) {
      const key = arg.slice(2);
      const next = argv[i + 1];
      if (next === undefined || next.startsWith('--')) {
        opts[key] = true;
      } else {
        opts[key] = next;
        i++;
      }
    } else {
      positional.push(arg);
    }
  }
  return { positional, opts };
}

function loadLog(path) {
  const genealogy = new Genealogy();
  if (fs.existsSync(path)) {
    for (const line of fs.readFileSync(path, 'utf8').split('\n')) {
      const trimmed = line.trim();
      if (trimmed) genealogy.append(JSON.parse(trimmed));
    }
  }
  return genealogy;
}

function print(value) {
  process.stdout.write(JSON.stringify(value, null, 2) + '\n');
}

const [command, ...rest] = process.argv.slice(2);
const { positional, opts } = parseArgs(rest);
const logPath = typeof opts.log === 'string' ? opts.log : 'genealogy.log.jsonl';

try {
  const genealogy = loadLog(logPath);
  const nextTs = () => (opts.ts !== undefined ? Number(opts.ts) : genealogy.lastTs + 1);
  const at = opts.at !== undefined ? Number(opts.at) : Infinity;

  switch (command) {
    case 'add-batch': {
      const record = { type: 'add', id: positional[0], note: opts.note ?? '', ts: nextTs() };
      genealogy.append(record);
      fs.appendFileSync(logPath, JSON.stringify(record) + '\n');
      print({ ok: true, record });
      break;
    }
    case 'add-edge': {
      const record = { type: 'edge', child: positional[0], parent: positional[1], ts: nextTs() };
      genealogy.append(record);
      fs.appendFileSync(logPath, JSON.stringify(record) + '\n');
      print({ ok: true, record });
      break;
    }
    case 'correct-edge': {
      const record = makeCorrection(positional[0], positional[1], positional[2], nextTs());
      genealogy.append(record);
      fs.appendFileSync(logPath, JSON.stringify(record) + '\n');
      print({ ok: true, record });
      break;
    }
    case 'delete-batch': {
      const record = { type: 'delete', id: positional[0], ts: nextTs() };
      genealogy.append(record);
      fs.appendFileSync(logPath, JSON.stringify(record) + '\n');
      print({ ok: true, record });
      break;
    }
    case 'ancestors':
      print(genealogy.ancestors(positional[0], at));
      break;
    case 'descendants':
      print(genealogy.descendants(positional[0], at));
      break;
    case 'search': {
      const query = {};
      if (opts.phrase !== undefined) query.phrase = opts.phrase;
      if (opts.near !== undefined) {
        query.near = String(opts.near).split(',');
        if (opts.dist !== undefined) query.distance = Number(opts.dist);
      }
      print({ results: genealogy.search(query, at) });
      break;
    }
    case 'cert':
      print(genealogy.certificate(positional[0], at));
      break;
    case 'prove':
      print(genealogy.inclusionProof(positional[0]));
      break;
    case 'verify-proof': {
      const proof = JSON.parse(fs.readFileSync(positional[0], 'utf8'));
      Genealogy.verifyInclusion(proof);
      print({ ok: true, id: proof.id, root: proof.root });
      break;
    }
    default:
      process.stderr.write(
        'usage: genealogy <add-batch|add-edge|correct-edge|delete-batch|ancestors|descendants|search|cert|prove|verify-proof> ...\n'
      );
      process.exitCode = 2;
  }
} catch (err) {
  if (err instanceof GenealogyError) {
    process.stderr.write(`${err.code}: ${err.message}\n`);
    process.exitCode = 1;
  } else {
    throw err;
  }
}
