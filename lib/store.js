import { appendFileSync, existsSync, readFileSync, truncateSync, writeFileSync } from "node:fs";
import { decodeBlockAt, encodeBlock, IncompleteTail, ZERO_HASH } from "./format.js";
import { CorruptError, ForkError, BusinessError } from "./errors.js";
import { applyRecord, cloneState, emptyState } from "./engine.js";

export const SNAPSHOT_INTERVAL = 4;

export function scanBuffer(buf, { allowTruncatedTail = false } = {}) {
  const blocks = [];
  const childOf = new Map();
  let offset = 0;
  let expectedSeq = 1;
  let prevHash = ZERO_HASH;
  let truncated = false;
  while (offset < buf.length) {
    let block;
    try {
      block = decodeBlockAt(buf, offset);
    } catch (err) {
      if (err instanceof IncompleteTail && allowTruncatedTail) {
        truncated = true;
        break;
      }
      if (err instanceof IncompleteTail) {
        throw new CorruptError("INCOMPLETE_BLOCK", err.message);
      }
      throw err;
    }
    const parentHex = block.prevHash.toString("hex");
    if (childOf.has(parentHex)) {
      throw new ForkError(
        `前向哈希 ${parentHex.slice(0, 16)}… 已被序号 ${childOf.get(parentHex)} 引用, ` +
          `又出现序号 ${block.seq}, 判定为分叉, 拒绝自动选择`,
      );
    }
    if (block.seq !== expectedSeq) {
      throw new CorruptError(
        "SEQ_MISMATCH",
        `块序号 ${block.seq} 与期望序号 ${expectedSeq} 不一致`,
      );
    }
    if (parentHex !== prevHash.toString("hex")) {
      throw new CorruptError("CHAIN_BREAK", `seq ${block.seq} 前向哈希与链顶不匹配`);
    }
    childOf.set(parentHex, block.seq);
    blocks.push({ ...block, offset });
    offset += block.length;
    prevHash = block.hash;
    expectedSeq += 1;
  }
  return { blocks, truncated, tipHash: prevHash, nextSeq: expectedSeq, validLength: offset };
}

export function loadChain(path) {
  if (!existsSync(path)) {
    return { blocks: [], truncated: false, tipHash: ZERO_HASH, nextSeq: 1, validLength: 0 };
  }
  return scanBuffer(readFileSync(path), { allowTruncatedTail: true });
}

export function computeState(blocks, uptoSeq = Infinity) {
  const state = emptyState();
  for (const block of blocks) {
    if (block.seq > uptoSeq) break;
    for (const rec of block.records) applyRecord(state, rec);
    state.seq = block.seq;
  }
  return state;
}

export function appendBatch(path, records) {
  if (!Array.isArray(records) || records.length === 0) {
    throw new BusinessError("INVALID_RECORD", "批次必须是非空记录数组");
  }
  const chain = loadChain(path);
  const state = computeState(chain.blocks);
  for (const rec of records) applyRecord(state, rec);
  const seq = chain.nextSeq;
  state.seq = seq;
  const snapshot = seq % SNAPSHOT_INTERVAL === 0 ? cloneState(state) : null;
  const bytes = encodeBlock({ seq, prevHash: chain.tipHash, records, snapshot });
  if (!existsSync(path)) writeFileSync(path, "");
  if (chain.truncated) truncateSync(path, chain.validLength);
  appendFileSync(path, bytes);
  return { seq, hash: decodeBlockAt(bytes, 0).hash };
}

export function rangeState(path, from, to) {
  if (!Number.isInteger(from) || !Number.isInteger(to) || from < 1 || to < from) {
    throw new BusinessError("BAD_RANGE", `非法区间 --from ${from} --to ${to}`);
  }
  const chain = loadChain(path);
  if (to > chain.blocks.length) {
    throw new BusinessError("RANGE_BEYOND_TIP", `区间终点 ${to} 超出已确认块数 ${chain.blocks.length}`);
  }
  let base = null;
  for (const block of chain.blocks) {
    if (block.seq > from) break;
    if (block.snapshot) base = block;
  }
  const state = base ? cloneState(base.snapshot) : emptyState();
  const decodedBlocks = [];
  for (const block of chain.blocks) {
    if (block.seq <= state.seq) continue;
    if (block.seq > to) break;
    for (const rec of block.records) applyRecord(state, rec);
    state.seq = block.seq;
    decodedBlocks.push(block.seq);
  }
  return {
    state,
    meta: { from, to, snapshotSeq: base ? base.seq : 0, decodedBlocks },
  };
}
