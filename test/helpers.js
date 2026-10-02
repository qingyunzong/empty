'use strict';

const os = require('node:os');
const fs = require('node:fs');
const path = require('node:path');
const { decodeBlock } = require('../src/block');
const { emptyState, applyLayer } = require('../src/state');

function tmpdir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'settle-test-'));
}

// 全量重放：不读索引、不用检查点快照，从文件头逐块解码，
// 沿父层哈希选择最长链（孤儿是死胡同，自然被排除），逐层重放增量。
function fullRecompute(dir, uptoLayer = Infinity) {
  const buf = fs.readFileSync(path.join(dir, 'data.log'));
  const byHash = new Map();
  const children = new Map();
  let offset = 0;
  let genesis = null;
  while (offset < buf.length) {
    let decoded;
    try {
      decoded = decodeBlock(buf, offset);
    } catch {
      break; // 截断/损坏处停止，半截块不参与全量计算
    }
    const { block, length } = decoded;
    const hex = block.hash.toString('hex');
    byHash.set(hex, block);
    const parentHex = block.parentHash.toString('hex');
    if (!children.has(parentHex)) children.set(parentHex, []);
    children.get(parentHex).push(block);
    if (block.type === 'genesis') genesis = block;
    offset += length;
  }
  if (!genesis) throw new Error('no genesis block found');

  // 从 genesis 出发选能到达最高层的链
  function bestChain(block) {
    const kids = children.get(block.hash.toString('hex')) || [];
    let best = [];
    for (const kid of kids) {
      const chain = bestChain(kid);
      const tail = chain.length > 0 ? chain[chain.length - 1].layer : kid.layer;
      const bestTail = best.length > 0 ? best[best.length - 1].layer : -1;
      if (tail > bestTail) best = [kid, ...chain];
    }
    return best;
  }
  const chain = [genesis, ...bestChain(genesis)].filter((b) => b.layer <= uptoLayer);

  let state = emptyState();
  let latestCp = -1;
  const applied = [];
  for (const block of chain) {
    if (block.type === 'genesis') {
      state = { accounts: structuredClone(block.payload.accounts), txs: {} };
    } else if (block.type === 'checkpoint') {
      // 全量计算用增量重放的结果与快照比对，而非直接信任快照
      latestCp = block.layer;
    } else {
      applyLayer(state, block.payload.txs, { layer: block.layer, latestCheckpointLayer: latestCp });
    }
    applied.push(block.layer);
  }
  return { state, layers: applied };
}

// 损坏指定层：翻转该层负载中的一个字节（CRC 必然不符）
function corruptLayerPayload(dir, layer) {
  const index = JSON.parse(fs.readFileSync(path.join(dir, 'index.json'), 'utf8'));
  const entry = index.layers[String(layer)];
  const fd = fs.openSync(path.join(dir, 'data.log'), 'r+');
  try {
    const pos = entry.offset + 86 + 3; // 头部 86 字节，进入负载区
    const one = Buffer.alloc(1);
    fs.readSync(fd, one, 0, 1, pos);
    one[0] ^= 0xFF;
    fs.writeSync(fd, one, 0, 1, pos);
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
}

module.exports = { tmpdir, fullRecompute, corruptLayerPayload };
