'use strict';

const fs = require('node:fs');
const {
  HEADER_SIZE,
  TYPE_SNAPSHOT,
  TYPE_DELTA,
  ZERO_HASH,
  sha256,
  encodeBlock,
  decodeBlock,
} = require('./ledger');
const { initialState, applyOp } = require('./state');
const { RejectError, CorruptError } = require('./errors');

const SNAPSHOT_INTERVAL = 4;

function indexPath(file) {
  return `${file}.index.json`;
}

function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') {
    const keys = Object.keys(value).sort();
    return `{${keys.map((k) => `${JSON.stringify(k)}:${canonical(value[k])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

function stateRoot(state) {
  return sha256(Buffer.from(canonical(state), 'utf8')).toString('hex');
}

function loadIndex(file) {
  let raw;
  try {
    raw = fs.readFileSync(indexPath(file));
  } catch {
    throw new RejectError(`ledger not initialized: ${file}`);
  }
  try {
    return { index: JSON.parse(raw.toString('utf8')), raw };
  } catch {
    throw new CorruptError(`index file is not valid JSON: ${indexPath(file)}`);
  }
}

function writeIndex(file, index) {
  const raw = Buffer.from(JSON.stringify(index, null, 2), 'utf8');
  fs.writeFileSync(indexPath(file), raw);
  return raw;
}

function makeCertificate(version, state, chainHash, snapshotOffset, indexRaw) {
  return {
    version,
    stateRoot: stateRoot(state),
    chainHash,
    snapshotOffset,
    indexHash: sha256(indexRaw).toString('hex'),
  };
}

function readBlock(file, offset) {
  const fd = fs.openSync(file, 'r');
  try {
    const block = decodeBlock(fd, offset);
    if (!block) throw new CorruptError(`no block at offset ${offset}`);
    return block;
  } finally {
    fs.closeSync(fd);
  }
}

function parseSnapshot(block) {
  try {
    return JSON.parse(block.payload.toString('utf8')).state;
  } catch {
    throw new CorruptError(`snapshot payload not decodable at offset ${block.offset}`);
  }
}

function parseDelta(block) {
  try {
    return JSON.parse(block.payload.toString('utf8'));
  } catch {
    throw new CorruptError(`delta payload not decodable at offset ${block.offset}`);
  }
}

function pickSnapshot(index, targetVersion) {
  let best = null;
  for (const snap of index.snapshots) {
    if (snap.version <= targetVersion && (!best || snap.version > best.version)) {
      best = snap;
    }
  }
  if (!best) throw new CorruptError('no snapshot at or before target version');
  return best;
}

// Restores state at `targetVersion` by reading the nearest snapshot at or
// before the target plus the deltas after it. Never touches later blocks.
function restore(file, targetVersion) {
  const { index, raw: indexRaw } = loadIndex(file);
  if (!Number.isSafeInteger(targetVersion) || targetVersion < 0 || targetVersion > index.lastVersion) {
    throw new RejectError(`unknown version: ${targetVersion} (last is ${index.lastVersion})`);
  }
  const snap = pickSnapshot(index, targetVersion);
  const snapBlock = readBlock(file, snap.offset);
  if (snapBlock.type !== TYPE_SNAPSHOT || snapBlock.version !== snap.version) {
    throw new CorruptError(`block at snapshot offset ${snap.offset} is not the expected snapshot`);
  }
  const state = parseSnapshot(snapBlock);
  let chainHash = snapBlock.hash.toString('hex');
  for (let v = snap.version + 1; v <= targetVersion; v += 1) {
    const offset = index.versions[String(v)];
    if (offset === undefined) throw new CorruptError(`missing delta offset for version ${v}`);
    const block = readBlock(file, offset);
    if (block.type !== TYPE_DELTA || block.version !== v) {
      throw new CorruptError(`block at offset ${offset} is not delta version ${v}`);
    }
    applyOp(state, parseDelta(block));
    chainHash = block.hash.toString('hex');
  }
  return {
    ok: true,
    version: targetVersion,
    state,
    certificate: makeCertificate(targetVersion, state, chainHash, snap.offset, indexRaw),
  };
}

function currentState(file) {
  const { index } = loadIndex(file);
  return restore(file, index.lastVersion).state;
}

function appendBlock(file, index, { version, type, payload }) {
  const offset = fs.statSync(file).size;
  const block = encodeBlock({
    version,
    type,
    offset,
    payload,
    prevHash: Buffer.from(index.head.hash, 'hex'),
  });
  fs.appendFileSync(file, block);
  index.head = { offset, hash: sha256(block).toString('hex') };
  return offset;
}

function initLedger(file, total) {
  if (!Number.isSafeInteger(total) || total < 0) {
    throw new RejectError(`invalid total: ${total}`);
  }
  if (fs.existsSync(file) || fs.existsSync(indexPath(file))) {
    throw new RejectError(`ledger already initialized: ${file}`);
  }
  const state = initialState(total);
  const index = {
    lastVersion: 0,
    head: { offset: 0, hash: ZERO_HASH.toString('hex') },
    latestSnapshot: { version: 0, offset: 0 },
    snapshots: [{ version: 0, offset: 0 }],
    versions: {},
  };
  fs.writeFileSync(file, Buffer.alloc(0));
  appendBlock(file, index, {
    version: 0,
    type: TYPE_SNAPSHOT,
    payload: JSON.stringify({ state }),
  });
  const indexRaw = writeIndex(file, index);
  return {
    ok: true,
    state,
    certificate: makeCertificate(0, state, index.head.hash, 0, indexRaw),
  };
}

function mutate(file, op) {
  const { index } = loadIndex(file);
  const state = currentState(file);
  const result = applyOp(state, op); // may reject; nothing written yet
  const version = index.lastVersion + 1;
  index.versions[String(version)] = appendBlock(file, index, {
    version,
    type: TYPE_DELTA,
    payload: JSON.stringify(op),
  });
  index.lastVersion = version;
  if (version - index.latestSnapshot.version >= SNAPSHOT_INTERVAL) {
    const offset = appendBlock(file, index, {
      version,
      type: TYPE_SNAPSHOT,
      payload: JSON.stringify({ state }),
    });
    index.latestSnapshot = { version, offset };
    index.snapshots.push({ version, offset });
  }
  const indexRaw = writeIndex(file, index);
  return {
    ok: true,
    version,
    result,
    state,
    certificate: makeCertificate(version, state, index.head.hash, index.latestSnapshot.offset, indexRaw),
  };
}

// Sequentially decodes and validates every block, checks the hash chain and
// the index, and replays all deltas to compute the final certificate.
function verify(file) {
  const { index, raw: indexRaw } = loadIndex(file);
  const fd = fs.openSync(file, 'r');
  const blocks = [];
  try {
    let offset = 0;
    let prevHash = ZERO_HASH;
    for (;;) {
      const block = decodeBlock(fd, offset);
      if (!block) break;
      if (!block.prevHash.equals(prevHash)) {
        throw new CorruptError(`hash chain broken at offset ${offset}`);
      }
      blocks.push(block);
      prevHash = block.hash;
      offset += block.size;
    }
  } finally {
    fs.closeSync(fd);
  }
  if (blocks.length === 0) throw new CorruptError('ledger file is empty');
  if (blocks[0].type !== TYPE_SNAPSHOT || blocks[0].version !== 0) {
    throw new CorruptError('first block is not the genesis snapshot');
  }

  const state = parseSnapshot(blocks[0]);
  const versions = {};
  const snapshots = [{ version: 0, offset: 0 }];
  let lastVersion = 0;
  for (let i = 1; i < blocks.length; i += 1) {
    const block = blocks[i];
    if (block.type === TYPE_DELTA) {
      if (block.version !== lastVersion + 1) {
        throw new CorruptError(`delta version gap at offset ${block.offset}`);
      }
      lastVersion = block.version;
      versions[String(block.version)] = block.offset;
      applyOp(state, parseDelta(block));
    } else {
      if (block.version !== lastVersion) {
        throw new CorruptError(`snapshot version mismatch at offset ${block.offset}`);
      }
      const snapState = parseSnapshot(block);
      if (stateRoot(snapState) !== stateRoot(state)) {
        throw new CorruptError(`snapshot state mismatch at offset ${block.offset}`);
      }
      snapshots.push({ version: block.version, offset: block.offset });
    }
  }

  const head = blocks[blocks.length - 1];
  const latestSnapshot = snapshots[snapshots.length - 1];
  const expectedIndex = {
    lastVersion,
    head: { offset: head.offset, hash: head.hash.toString('hex') },
    latestSnapshot,
    snapshots,
    versions,
  };
  if (canonical(expectedIndex) !== canonical(index)) {
    throw new CorruptError('index file does not match ledger contents');
  }

  return {
    ok: true,
    blocks: blocks.length,
    version: lastVersion,
    state,
    certificate: makeCertificate(
      lastVersion,
      state,
      head.hash.toString('hex'),
      latestSnapshot.offset,
      indexRaw,
    ),
  };
}

module.exports = {
  SNAPSHOT_INTERVAL,
  indexPath,
  canonical,
  stateRoot,
  initLedger,
  mutate,
  restore,
  verify,
  currentState,
};
