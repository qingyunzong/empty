'use strict';

const fs = require('node:fs');
const path = require('node:path');
const {
  ZERO_HASH,
  sha256,
  txSetHash,
  encodeBlock,
  decodeBlock,
} = require('./block');
const {
  BusinessError,
  CorruptionError,
  IndexCorruptionError,
  CrashSimulatedError,
} = require('./errors');
const { emptyState, applyLayer } = require('./state');

const LOG_FILE = 'data.log';
const INDEX_FILE = 'index.json';
const DELTA_TYPES = new Set(['reserve', 'freeze', 'pay', 'revert']);

// 存储布局：
//   <dir>/data.log   追加写的块日志（genesis 为第 0 层）
//   <dir>/index.json { head:{layer,hash,offset}, layers:{ "<层>":{offset,hash} }, checkpoints:[{layer,offset,hash}] }
//
// 提交协议：先写块并 fsync，再校验整层事务，最后更新索引完成"链接"。
// 校验失败或崩溃时，已写入但未链接的块成为孤儿；恢复时列出但绝不并入状态。
class Store {
  constructor(dir) {
    this.dir = dir;
    this.logPath = path.join(dir, LOG_FILE);
    this.indexPath = path.join(dir, INDEX_FILE);
  }

  static init(dir, accounts) {
    fs.mkdirSync(dir, { recursive: true });
    const store = new Store(dir);
    if (fs.existsSync(store.logPath)) throw new BusinessError(`store already initialized: ${dir}`);
    const normalized = {};
    for (const [name, a] of Object.entries(accounts || {})) {
      normalized[name] = {
        budget: a.budget | 0,
        credit: a.credit | 0,
        balance: a.balance | 0,
      };
    }
    const buf = encodeBlock({
      type: 'genesis',
      layer: 0,
      parentHash: ZERO_HASH,
      txHash: txSetHash([]),
      offset: 0,
      payload: { accounts: normalized },
    });
    store.appendRaw(buf);
    const hash = sha256(buf).toString('hex');
    store.writeIndex({
      head: { layer: 0, hash, offset: 0 },
      layers: { '0': { offset: 0, hash } },
      checkpoints: [],
    });
    return store;
  }

  static open(dir) {
    const store = new Store(dir);
    if (!fs.existsSync(store.logPath)) throw new BusinessError(`store not initialized: ${dir}`);
    return store;
  }

  readIndex() {
    if (!fs.existsSync(this.indexPath)) throw new IndexCorruptionError('index file missing');
    try {
      return JSON.parse(fs.readFileSync(this.indexPath, 'utf8'));
    } catch {
      throw new IndexCorruptionError('index file is not valid JSON');
    }
  }

  writeIndex(index) {
    const tmp = `${this.indexPath}.tmp`;
    const fd = fs.openSync(tmp, 'w');
    try {
      fs.writeSync(fd, JSON.stringify(index, null, 2));
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    fs.renameSync(tmp, this.indexPath);
  }

  appendRaw(buf) {
    const fd = fs.openSync(this.logPath, 'a');
    try {
      fs.writeSync(fd, buf, 0, buf.length, null);
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
  }

  fileSize() {
    return fs.statSync(this.logPath).size;
  }

  readLog() {
    return fs.readFileSync(this.logPath);
  }

  // 顺序解码全部可解码块；遇到不可解码字节即停并记录位置。
  scan(buf = this.readLog()) {
    const blocks = [];
    let offset = 0;
    let stop = null;
    while (offset < buf.length) {
      try {
        const { block, length } = decodeBlock(buf, offset);
        blocks.push(block);
        offset += length;
      } catch (err) {
        if (err instanceof CorruptionError) {
          stop = { offset, reason: err.message, torn: err.torn };
          break;
        }
        throw err;
      }
    }
    return { blocks, stop };
  }

  latestCheckpointLayer(index) {
    let max = -1;
    for (const cp of index.checkpoints) if (cp.layer > max) max = cp.layer;
    return max;
  }

  checkpointAtOrBefore(index, layer) {
    let best = null;
    for (const cp of index.checkpoints) {
      if (cp.layer <= layer && (!best || cp.layer > best.layer)) best = cp;
    }
    return best;
  }

  // 按索引条目读取块：偏移处无法解码视为索引损坏；CRC 不符视为数据损坏。
  decodeForEntry(buf, entry, label) {
    if (!entry) throw new IndexCorruptionError(`index missing entry for ${label}`);
    try {
      return decodeBlock(buf, entry.offset).block;
    } catch (err) {
      if (err instanceof CorruptionError && (err.torn || /bad magic|unsupported version|unknown block type/.test(err.message))) {
        throw new IndexCorruptionError(`${label}: index offset ${entry.offset} does not point to a valid block`);
      }
      throw err;
    }
  }

  // 索引指向的偏移处层号或哈希不符 -> 索引损坏
  checkEntry(block, entry, label) {
    if (block.selfOffset !== entry.offset) {
      throw new IndexCorruptionError(
        `${label}: offset mismatch (index ${entry.offset}, block header ${block.selfOffset})`,
      );
    }
    if (block.hash.toString('hex') !== entry.hash) {
      throw new IndexCorruptionError(`${label}: hash mismatch at offset ${entry.offset}`);
    }
  }

  applyBlock(state, block, index) {
    if (block.type === 'genesis') {
      return { accounts: structuredClone(block.payload.accounts), txs: {} };
    }
    if (block.type === 'checkpoint') {
      return structuredClone(block.payload.state);
    }
    // 重放历史层时，检查点限制按"该层提交时刻"的检查点计算
    let latestCp = -1;
    for (const cp of index.checkpoints) {
      if (cp.layer < block.layer && cp.layer > latestCp) latestCp = cp.layer;
    }
    return applyLayer(state, block.payload.txs, { layer: block.layer, latestCheckpointLayer: latestCp });
  }

  // 恢复状态：从最近检查点块 + 后续增量解码，不重放全文件。
  // opts.checkpointLayer 指定恢复到该检查点；opts.targetLayer 指定目标层。
  restore(opts = {}) {
    const index = this.readIndex();
    const buf = this.readLog();
    const head = index.head;

    let target;
    if (opts.targetLayer != null) target = opts.targetLayer;
    else if (opts.checkpointLayer != null) target = opts.checkpointLayer;
    else target = head.layer;
    if (!Number.isInteger(target) || target < 0) throw new BusinessError(`invalid target layer: ${target}`);
    if (target > head.layer) throw new BusinessError(`target layer ${target} beyond head ${head.layer}`);

    let cpEntry = null;
    if (opts.checkpointLayer != null) {
      cpEntry = index.checkpoints.find((c) => c.layer === opts.checkpointLayer) || null;
      if (!cpEntry) throw new BusinessError(`no checkpoint at layer ${opts.checkpointLayer}`);
      if (cpEntry.layer > target) throw new BusinessError(`checkpoint layer ${cpEntry.layer} beyond target ${target}`);
    } else {
      cpEntry = this.checkpointAtOrBefore(index, target);
    }

    let state = emptyState();
    let startLayer = 0;
    let prevHash = null;
    if (cpEntry) {
      const block = this.decodeForEntry(buf, cpEntry, `checkpoint ${cpEntry.layer}`);
      this.checkEntry(block, cpEntry, `checkpoint ${cpEntry.layer}`);
      if (block.type !== 'checkpoint') {
        throw new IndexCorruptionError(`checkpoint ${cpEntry.layer}: offset points to a ${block.type} block`);
      }
      state = structuredClone(block.payload.state);
      startLayer = cpEntry.layer + 1;
      prevHash = block.hash.toString('hex');
    }

    for (let layer = startLayer; layer <= target; layer++) {
      const entry = index.layers[String(layer)];
      const block = this.decodeForEntry(buf, entry, `layer ${layer}`);
      this.checkEntry(block, entry, `layer ${layer}`);
      if (block.layer !== layer) {
        throw new IndexCorruptionError(`index offset for layer ${layer} points to layer ${block.layer}`);
      }
      if (prevHash !== null && block.parentHash.toString('hex') !== prevHash) {
        throw new CorruptionError(`broken hash chain at layer ${layer}`);
      }
      state = this.applyBlock(state, block, index);
      prevHash = block.hash.toString('hex');
    }

    return { layer: target, state, orphans: this.findOrphans(buf, index) };
  }

  // 孤儿：可完整解码但不在已链接链上的块。只报告，绝不并入状态。
  findOrphans(buf, index) {
    const canonical = new Set(Object.values(index.layers).map((e) => e.offset));
    const { blocks } = this.scan(buf);
    return blocks
      .filter((b) => !canonical.has(b.offset))
      .map((b) => ({
        offset: b.offset,
        layer: b.layer,
        type: b.type,
        txs: Array.isArray(b.payload && b.payload.txs) ? b.payload.txs.map((t) => t.id) : [],
        reason: 'written but not linked',
      }));
  }

  // 提交一个增量层。opts.crash: 'after-write' | 'torn' 用于测试崩溃恢复。
  commitLayer(type, txs, opts = {}) {
    if (!DELTA_TYPES.has(type)) throw new BusinessError(`invalid layer type: ${type}`);
    const index = this.readIndex();
    const head = index.head;
    const { state } = this.restore({});
    const layer = head.layer + 1;
    const offset = this.fileSize();
    const buf = encodeBlock({
      type,
      layer,
      parentHash: Buffer.from(head.hash, 'hex'),
      txHash: txSetHash(txs),
      offset,
      payload: { txs },
    });

    if (opts.crash === 'torn') {
      this.appendRaw(buf.subarray(0, Math.floor(buf.length / 2)));
      throw new CrashSimulatedError('simulated crash: torn block write');
    }
    this.appendRaw(buf); // 先写块
    if (opts.crash === 'after-write') {
      throw new CrashSimulatedError('simulated crash: block written but not linked');
    }

    // 再校验整层：任一事务失败则整层不提交，已写块成为孤儿
    const next = structuredClone(state);
    applyLayer(next, txs, { layer, latestCheckpointLayer: this.latestCheckpointLayer(index) });

    // 最后链接：更新索引
    const hash = sha256(buf).toString('hex');
    index.layers[String(layer)] = { offset, hash };
    index.head = { layer, hash, offset };
    this.writeIndex(index);
    return { layer, hash, offset };
  }

  // 检查点：把当前状态快照写入新的检查点块并链接。
  checkpoint() {
    const index = this.readIndex();
    const { state } = this.restore({});
    const head = index.head;
    const layer = head.layer + 1;
    const offset = this.fileSize();
    const buf = encodeBlock({
      type: 'checkpoint',
      layer,
      parentHash: Buffer.from(head.hash, 'hex'),
      txHash: txSetHash([]),
      offset,
      payload: { state },
    });
    this.appendRaw(buf);
    const hash = sha256(buf).toString('hex');
    index.layers[String(layer)] = { offset, hash };
    index.head = { layer, hash, offset };
    index.checkpoints.push({ layer, offset, hash });
    this.writeIndex(index);
    return { layer, hash, offset };
  }

  // 校验：索引与数据一致性、哈希链、CRC、事务集合哈希；报告孤儿与截断尾部。
  verify() {
    const index = this.readIndex();
    const buf = this.readLog();
    const head = index.head;
    const warnings = [];

    let prevHash = null;
    let canonicalEnd = 0;
    for (let layer = 0; layer <= head.layer; layer++) {
      const entry = index.layers[String(layer)];
      const block = this.decodeForEntry(buf, entry, `layer ${layer}`);
      this.checkEntry(block, entry, `layer ${layer}`);
      if (block.layer !== layer) {
        throw new IndexCorruptionError(`index offset for layer ${layer} points to layer ${block.layer}`);
      }
      if (prevHash !== null && block.parentHash.toString('hex') !== prevHash) {
        throw new CorruptionError(`broken hash chain at layer ${layer}`);
      }
      if (DELTA_TYPES.has(block.type)) {
        const expect = txSetHash(block.payload.txs || []).toString('hex');
        if (expect !== block.txSetHash.toString('hex')) {
          throw new CorruptionError(`tx set hash mismatch at layer ${layer}`);
        }
      }
      prevHash = block.hash.toString('hex');
      canonicalEnd = Math.max(canonicalEnd, block.offset + block.length);
    }
    if (prevHash !== head.hash) throw new IndexCorruptionError('head hash mismatch');

    for (const cp of index.checkpoints) {
      const block = this.decodeForEntry(buf, cp, `checkpoint ${cp.layer}`);
      this.checkEntry(block, cp, `checkpoint ${cp.layer}`);
      if (block.type !== 'checkpoint') {
        throw new IndexCorruptionError(`checkpoint ${cp.layer}: offset points to a ${block.type} block`);
      }
    }

    const { blocks, stop } = this.scan(buf);
    const canonical = new Set(Object.values(index.layers).map((e) => e.offset));
    const orphans = blocks
      .filter((b) => !canonical.has(b.offset))
      .map((b) => ({
        offset: b.offset,
        layer: b.layer,
        type: b.type,
        txs: Array.isArray(b.payload && b.payload.txs) ? b.payload.txs.map((t) => t.id) : [],
        reason: 'written but not linked',
      }));
    if (stop) {
      // 已链接链完整时，尾部/孤儿区的半截块只是崩溃残留，不影响状态
      warnings.push(
        stop.offset >= canonicalEnd
          ? `incomplete tail at offset ${stop.offset}: ${stop.reason}`
          : `undecodable orphan region at offset ${stop.offset}: ${stop.reason}`,
      );
    }

    return { ok: true, layers: head.layer, head: head.hash, orphans, warnings };
  }
}

module.exports = { Store, LOG_FILE, INDEX_FILE };
