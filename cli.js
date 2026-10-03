#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { Engine } = require('./src/engine');

const USAGE = 'usage: node cli.js trace --in <dir> --out <dir>\n';

function parseArgs(argv) {
  const args = { _: [] };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--in') args.inDir = argv[++i];
    else if (a === '--out') args.outDir = argv[++i];
    else if (a.startsWith('--in=')) args.inDir = a.slice('--in='.length);
    else if (a.startsWith('--out=')) args.outDir = a.slice('--out='.length);
    else args._.push(a);
  }
  return args;
}

function readLots(file, errors) {
  if (!fs.existsSync(file)) {
    errors.push({ error: 'missing_input', message: 'lots.json is required' });
    return [];
  }
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (err) {
    errors.push({ error: 'invalid_lots', message: `lots.json is not valid JSON: ${err.message}` });
    return [];
  }
}

function readJsonl(file, errors, code) {
  if (!fs.existsSync(file)) return [];
  const out = [];
  const lines = fs.readFileSync(file, 'utf8').split('\n');
  lines.forEach((line, idx) => {
    const trimmed = line.trim();
    if (trimmed === '') return;
    try {
      out.push(JSON.parse(trimmed));
    } catch (err) {
      errors.push({ error: code, message: `${path.basename(file)}:${idx + 1} is not valid JSON: ${err.message}` });
    }
  });
  return out;
}

function writeJsonl(file, records) {
  fs.writeFileSync(file, records.map((r) => JSON.stringify(r)).join('\n') + (records.length > 0 ? '\n' : ''));
}

function serializeCert(record) {
  return {
    lot: record.lot,
    seq: record.seq,
    hash: record.hash,
    status: record.status,
    state: record.state,
    superseded_by: record.superseded_by,
    basis: record.basis,
  };
}

function run(argv) {
  const args = parseArgs(argv);
  if (args._[0] !== 'trace' || !args.inDir || !args.outDir) {
    process.stderr.write(USAGE);
    return 1;
  }
  const inDir = args.inDir;
  const outDir = args.outDir;
  fs.mkdirSync(outDir, { recursive: true });

  const errors = [];
  const lots = readLots(path.join(inDir, 'lots.json'), errors);
  const edges = readJsonl(path.join(inDir, 'edges.jsonl'), errors, 'invalid_edges');
  const tests = readJsonl(path.join(inDir, 'tests.jsonl'), errors, 'invalid_tests');
  const corrections = readJsonl(path.join(inDir, 'corrections.jsonl'), errors, 'invalid_corrections');

  let engine = null;
  if (errors.length === 0) {
    engine = new Engine({ lots, edges, tests });
    errors.push(...engine.errors);
  }
  // Structural errors (cycle, dangling references, malformed records) are
  // fatal: no certificates may be produced.
  if (errors.length > 0) {
    writeJsonl(path.join(outDir, 'errors.jsonl'), errors);
    return 2;
  }

  engine.computeAll();
  engine.issueCertificates();

  const correctionErrors = [];
  for (const corr of corrections) {
    const err = engine.applyCorrection(corr);
    if (err) correctionErrors.push(err);
  }

  const finishedGoods = {};
  const allLots = {};
  for (const id of engine.topo) {
    const st = engine.state.get(id);
    allLots[id] = { status: st.status };
  }
  for (const id of engine.finishedGoodIds()) {
    const cert = engine.certs.get(id);
    finishedGoods[id] = { status: engine.state.get(id).status, certificate_hash: cert.hash };
  }
  const trace = {
    finished_goods: finishedGoods,
    lots: allLots,
    corrections_applied: engine.stats.correctionsApplied,
    corrections_rejected: correctionErrors.length,
  };
  fs.writeFileSync(path.join(outDir, 'trace.json'), JSON.stringify(trace, null, 2) + '\n');
  writeJsonl(path.join(outDir, 'certificates.jsonl'), engine.certLog.map(serializeCert));

  if (correctionErrors.length > 0) {
    writeJsonl(path.join(outDir, 'errors.jsonl'), correctionErrors);
    return 2;
  }
  return 0;
}

if (require.main === module) {
  process.exitCode = run(process.argv.slice(2));
}

module.exports = { run };
