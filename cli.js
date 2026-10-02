#!/usr/bin/env node
'use strict';

// Evidence-pack CLI.
//   node cli.js pack      <data> <idx>
//   node cli.js verify    <data> <idx>
//   node cli.js prove     <data> <idx> <offset> <len>
//   node cli.js checkProof <proof.json> [expectedRootHex]
//   node cli.js extract   <data> <idx> <offset> <len>   (raw bytes to stdout)
//   node cli.js scan      <data> [idxOut]               (degraded rebuild from data only)
// Errors are emitted to stderr as one JSON line; exit code 1.
// Block size defaults to 4096, override with EVIDENCE_BLOCK_SIZE.

const fs = require('node:fs');
const ev = require('./lib/evidence');

function readData(path) {
  try {
    return fs.readFileSync(path);
  } catch (err) {
    throw new ev.EvidenceError('ERR_IO', `cannot read ${path}: ${err.message}`, { file: path });
  }
}

function parseRange(off, len) {
  const offset = Number(off);
  const length = Number(len);
  if (!Number.isSafeInteger(offset) || !Number.isSafeInteger(length)) {
    throw new ev.EvidenceError('ERR_RANGE', `offset/len must be integers, got "${off}" "${len}"`);
  }
  return { offset, length };
}

function writeIndex(path, index) {
  fs.writeFileSync(path, JSON.stringify(index, null, 2) + '\n');
}

function dispatch(argv, io) {
  const [cmd, ...args] = argv;
  const blockSize = Number(process.env.EVIDENCE_BLOCK_SIZE) || ev.DEFAULT_BLOCK_SIZE;
  switch (cmd) {
    case 'pack': {
      const [dataPath, idxPath] = args;
      if (!dataPath || !idxPath) throw new ev.EvidenceError('ERR_FORMAT', 'usage: pack <data> <idx>');
      const index = ev.buildIndex(readData(dataPath), blockSize);
      writeIndex(idxPath, index);
      io.stdout(JSON.stringify({ ok: true, root: index.root, blockCount: index.blockCount }) + '\n');
      return 0;
    }
    case 'verify': {
      const [dataPath, idxPath] = args;
      if (!dataPath || !idxPath) throw new ev.EvidenceError('ERR_FORMAT', 'usage: verify <data> <idx>');
      const res = ev.verify(readData(dataPath), ev.readIndexFile(idxPath));
      io.stdout(JSON.stringify(res) + '\n');
      return 0;
    }
    case 'prove': {
      const [dataPath, idxPath, off, len] = args;
      if (!dataPath || !idxPath || off === undefined || len === undefined) {
        throw new ev.EvidenceError('ERR_FORMAT', 'usage: prove <data> <idx> <offset> <len>');
      }
      const data = readData(dataPath);
      const index = ev.readIndexFile(idxPath);
      ev.verify(data, index); // refuse to prove against data that fails integrity
      const { offset, length } = parseRange(off, len);
      const proof = ev.generateProof(index, offset, length);
      io.stdout(JSON.stringify(proof, null, 2) + '\n');
      return 0;
    }
    case 'checkProof': {
      const [proofPath, root] = args;
      if (!proofPath) throw new ev.EvidenceError('ERR_FORMAT', 'usage: checkProof <proof.json> [expectedRootHex]');
      const res = ev.checkProof(ev.readProofFile(proofPath), root);
      io.stdout(JSON.stringify(res) + '\n');
      return 0;
    }
    case 'extract': {
      const [dataPath, idxPath, off, len] = args;
      if (!dataPath || !idxPath || off === undefined || len === undefined) {
        throw new ev.EvidenceError('ERR_FORMAT', 'usage: extract <data> <idx> <offset> <len>');
      }
      const { offset, length } = parseRange(off, len);
      io.stdout(ev.extract(readData(dataPath), ev.readIndexFile(idxPath), offset, length));
      return 0;
    }
    case 'scan': {
      const [dataPath, idxOut] = args;
      if (!dataPath) throw new ev.EvidenceError('ERR_FORMAT', 'usage: scan <data> [idxOut]');
      const index = ev.buildIndex(readData(dataPath), blockSize);
      if (idxOut) writeIndex(idxOut, index);
      io.stdout(JSON.stringify({ ok: true, root: index.root, blockCount: index.blockCount }) + '\n');
      return 0;
    }
    default:
      io.stderr(JSON.stringify({
        error: 'ERR_FORMAT',
        message: 'unknown command; expected pack|verify|prove|checkProof|extract|scan',
      }) + '\n');
      return 2;
  }
}

// Runs one CLI invocation. io = { stdout(chunk), stderr(chunk) }.
// Returns the exit code; errors become one JSON line on stderr.
function run(argv, io) {
  try {
    return dispatch(argv, io);
  } catch (err) {
    const payload = err instanceof ev.EvidenceError
      ? err.toJSON()
      : { error: 'ERR_INTERNAL', message: String((err && err.message) || err) };
    io.stderr(JSON.stringify(payload) + '\n');
    return 1;
  }
}

if (require.main === module) {
  const code = run(process.argv.slice(2), {
    stdout: (chunk) => process.stdout.write(chunk),
    stderr: (chunk) => process.stderr.write(chunk),
  });
  process.exit(code);
}

module.exports = { run };
