#!/usr/bin/env node
'use strict';
const fs = require('node:fs');
const ev = require('./evidence.js');

class UsageError extends Error {}

function emitError(io, err) {
  const code = err instanceof ev.EvidenceError ? err.code : 'ERR_FORMAT';
  const out = { ok: false, code, message: err.message };
  if (err.details) Object.assign(out, err.details);
  io.stderr(JSON.stringify(out) + '\n');
  return 1;
}

function ok(io, obj) {
  io.stdout(JSON.stringify({ ok: true, ...obj }) + '\n');
}

const USAGE = [
  'usage:',
  '  node cli.js pack <input> <dataOut> <idxOut> [blockSize]',
  '  node cli.js verify <data> <idx> [blockSize]',
  '  node cli.js scan <data> [blockSize]',
  '  node cli.js prove <data> <idx> <offset> <len> [proofOut]',
  '  node cli.js checkProof <proof.json> [rootHex]',
  '  node cli.js extract <data> <idx> <offset> <len> [outFile]',
  '',
].join('\n');

function need(cond) {
  if (!cond) throw new UsageError();
}

function readData(path) {
  try {
    return fs.readFileSync(path);
  } catch {
    throw new ev.EvidenceError('ERR_FORMAT', `cannot read data file: ${path}`);
  }
}

function readJson(path, what) {
  let text;
  try {
    text = fs.readFileSync(path, 'utf8');
  } catch {
    throw new ev.EvidenceError('ERR_FORMAT', `cannot read ${what} file: ${path}`);
  }
  try {
    return JSON.parse(text);
  } catch (e) {
    throw new ev.EvidenceError('ERR_FORMAT', `malformed ${what} JSON: ${e.message}`);
  }
}

function parseRange(offsetArg, lenArg, allowEmpty) {
  const offset = Number(offsetArg);
  const length = Number(lenArg);
  if (!Number.isInteger(offset) || offset < 0 || !Number.isInteger(length) || length < 0) {
    throw new ev.EvidenceError('ERR_RANGE', `bad offset/length: ${offsetArg} ${lenArg}`);
  }
  if (!allowEmpty && length === 0) {
    throw new ev.EvidenceError('ERR_RANGE', 'length must be > 0');
  }
  return { offset, length };
}

function loadVerifiedPair(dataPath, idxPath) {
  const data = readData(dataPath);
  const index = readJson(idxPath, 'index');
  ev.validateIndex(index);
  const badLeaves = ev.localizeAgainstIndex(data, index);
  if (badLeaves.length > 0) {
    throw new ev.EvidenceError('ERR_ROOT',
      `data does not match index at ${badLeaves.length} block(s)`, { leaves: badLeaves });
  }
  const recomputed = ev.merkleRootFromLeafHashes(ev.leafHashesOf(index.blocks)).toString('hex');
  if (recomputed !== index.root) {
    throw new ev.EvidenceError('ERR_ROOT',
      'index root inconsistent with index block table', { computedRoot: recomputed });
  }
  return { data, index };
}

function cmdPack(io, args) {
  const [input, dataOut, idxOut, bsArg] = args;
  need(input && dataOut && idxOut);
  const blockSize = bsArg === undefined ? ev.DEFAULT_BLOCK_SIZE : Number(bsArg);
  const data = readData(input);
  const index = ev.buildIndex(data, blockSize);
  fs.writeFileSync(dataOut, data);
  fs.writeFileSync(idxOut, JSON.stringify(index, null, 2) + '\n');
  ok(io, { command: 'pack', root: index.root, blocks: index.blocks.length,
           totalSize: index.totalSize, blockSize: index.blockSize, data: dataOut, index: idxOut });
}

function cmdVerify(io, args) {
  const [dataPath, idxPath, bsArg] = args;
  need(dataPath && idxPath);
  const data = readData(dataPath);
  if (!fs.existsSync(idxPath)) {
    const blockSize = bsArg === undefined ? ev.DEFAULT_BLOCK_SIZE : Number(bsArg);
    const scanned = ev.scanRoot(data, blockSize);
    ok(io, { command: 'verify', degraded: 'scan', reason: 'index missing',
             root: scanned.root, blocks: scanned.blocks.length,
             totalSize: data.length, blockSize });
    return;
  }
  const index = readJson(idxPath, 'index');
  ev.validateIndex(index);
  const badLeaves = ev.localizeAgainstIndex(data, index);
  const recomputed = ev.merkleRootFromLeafHashes(ev.leafHashesOf(index.blocks)).toString('hex');
  const indexRootConsistent = recomputed === index.root;
  if (badLeaves.length === 0 && indexRootConsistent) {
    ok(io, { command: 'verify', root: index.root, blocks: index.blocks.length, totalSize: index.totalSize });
    return;
  }
  throw new ev.EvidenceError('ERR_INDEX',
    'data and index roots disagree; degraded scan located mismatching leaves',
    { leaves: badLeaves, indexRootConsistent, computedRoot: recomputed, indexRoot: index.root });
}

function cmdScan(io, args) {
  const [dataPath, bsArg] = args;
  need(dataPath);
  const blockSize = bsArg === undefined ? ev.DEFAULT_BLOCK_SIZE : Number(bsArg);
  const data = readData(dataPath);
  const scanned = ev.scanRoot(data, blockSize);
  ok(io, { command: 'scan', root: scanned.root, blocks: scanned.blocks.length,
           totalSize: data.length, blockSize });
}

function cmdProve(io, args) {
  const [dataPath, idxPath, offsetArg, lenArg, proofOut] = args;
  need(dataPath && idxPath && offsetArg !== undefined && lenArg !== undefined);
  const { offset, length } = parseRange(offsetArg, lenArg, false);
  const { index } = loadVerifiedPair(dataPath, idxPath);
  const proof = ev.makeProof(index, offset, length);
  const text = JSON.stringify(proof, null, 2) + '\n';
  if (proofOut) {
    fs.writeFileSync(proofOut, text);
    ok(io, { command: 'prove', root: proof.root, offset, length,
             startLeaf: proof.startLeaf, leaves: proof.leaves.length,
             siblings: proof.siblings.length, proof: proofOut });
  } else {
    io.stdout(text);
  }
}

function cmdCheckProof(io, args) {
  const [proofPath, rootArg] = args;
  need(proofPath);
  const proof = readJson(proofPath, 'proof');
  const result = ev.checkProof(proof, rootArg);
  ok(io, { command: 'checkProof', root: result.root,
           offset: proof.offset, length: proof.length, leaves: proof.leaves.length });
}

function cmdExtract(io, args) {
  const [dataPath, idxPath, offsetArg, lenArg, outFile] = args;
  need(dataPath && idxPath && offsetArg !== undefined && lenArg !== undefined);
  const { offset, length } = parseRange(offsetArg, lenArg, true);
  const data = readData(dataPath);
  const index = readJson(idxPath, 'index');
  ev.validateIndex(index);
  if (offset + length > index.totalSize) {
    throw new ev.EvidenceError('ERR_RANGE',
      `range [${offset}, ${offset + length}) exceeds totalSize ${index.totalSize}`);
  }
  if (length > 0) {
    const startLeaf = Math.floor(offset / index.blockSize);
    const endLeaf = Math.floor((offset + length - 1) / index.blockSize);
    const badLeaves = [];
    for (let i = startLeaf; i <= endLeaf; i++) {
      const b = index.blocks[i];
      const actual = ev.sha256(data.subarray(b.offset, b.offset + b.length)).toString('hex');
      if (actual !== b.sha256) badLeaves.push(i);
    }
    if (badLeaves.length > 0) {
      throw new ev.EvidenceError('ERR_ROOT',
        'covered blocks fail integrity check', { leaves: badLeaves });
    }
  }
  const slice = data.subarray(offset, offset + length);
  if (outFile) {
    fs.writeFileSync(outFile, slice);
    ok(io, { command: 'extract', offset, length, out: outFile,
             sha256: ev.sha256(slice).toString('hex') });
  } else {
    io.stdout(slice);
  }
}

function run(argv) {
  const outChunks = [];
  const errChunks = [];
  const io = {
    stdout: (c) => outChunks.push(Buffer.isBuffer(c) ? c : Buffer.from(c)),
    stderr: (c) => errChunks.push(Buffer.isBuffer(c) ? c : Buffer.from(c)),
  };
  const [command, ...args] = argv;
  let code = 0;
  try {
    switch (command) {
      case 'pack': cmdPack(io, args); break;
      case 'verify': cmdVerify(io, args); break;
      case 'scan': cmdScan(io, args); break;
      case 'prove': cmdProve(io, args); break;
      case 'checkProof': cmdCheckProof(io, args); break;
      case 'extract': cmdExtract(io, args); break;
      default: throw new UsageError();
    }
  } catch (err) {
    if (err instanceof UsageError) {
      io.stderr(USAGE);
      code = 2;
    } else {
      code = emitError(io, err);
    }
  }
  return { code, stdout: Buffer.concat(outChunks), stderr: Buffer.concat(errChunks) };
}

module.exports = { run };

if (require.main === module) {
  const result = run(process.argv.slice(2));
  if (result.stdout.length) process.stdout.write(result.stdout);
  if (result.stderr.length) process.stderr.write(result.stderr);
  process.exitCode = result.code;
}
