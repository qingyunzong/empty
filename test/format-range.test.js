import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { crc32 } from "../lib/crc32.js";
import { decodeBlockAt, encodeBlock, ZERO_HASH } from "../lib/format.js";
import { CorruptError } from "../lib/errors.js";
import { appendBatch, computeState, loadChain, rangeState, scanBuffer } from "../lib/store.js";
import { tmpFile, runCli } from "./helpers.js";

test("crc32 标准向量", () => {
  assert.equal(crc32(Buffer.from("123456789")), 0xcbf43926);
  assert.equal(crc32(Buffer.from("")), 0);
});

test("越界通配读取按损坏处理", () => {
  const buf = encodeBlock({ seq: 1, prevHash: ZERO_HASH, records: [{ type: "credit", account: "A", amount: 1 }] });
  assert.throws(() => decodeBlockAt(buf, buf.length + 5), (err) => {
    assert.ok(err instanceof CorruptError);
    assert.equal(err.code, "OUT_OF_BOUNDS");
    return true;
  });
  assert.throws(() => decodeBlockAt(buf, -1), /越界读取/);
  assert.throws(() => scanBuffer(buf.subarray(0, buf.length - 3)), (err) => {
    assert.equal(err.code, "INCOMPLETE_BLOCK");
    return true;
  });
});

test("块尾部长度字段损坏但未越过文件尾时报告块不完整", () => {
  const file = tmpFile();
  appendBatch(file, [{ type: "credit", account: "A", amount: 100 }]);
  appendBatch(file, [{ type: "credit", account: "A", amount: 50 }]);
  const buf = Buffer.from(readFileSync(file));
  const chain = loadChain(file);
  const trailerLenOffset = chain.blocks[0].offset + chain.blocks[0].length - 4;
  buf.writeUInt32BE(chain.blocks[0].length + 8, trailerLenOffset);
  writeFileSync(file, buf);

  const verify = runCli(["verify", file]);
  assert.equal(verify.code, 2);
  assert.equal(verify.json.error.code, "INCOMPLETE_BLOCK");
  assert.match(verify.json.error.message, /块不完整/);
});

test("负载字节被篡改时 CRC32 校验失败", () => {
  const file = tmpFile();
  appendBatch(file, [{ type: "credit", account: "A", amount: 100 }]);
  const buf = Buffer.from(readFileSync(file));
  buf[60] ^= 0xff;
  writeFileSync(file, buf);
  const verify = runCli(["verify", file]);
  assert.equal(verify.code, 2);
  assert.equal(verify.json.error.code, "CRC_MISMATCH");
});

test("range 只解码索引覆盖的增量区间并向前补齐基础持仓", () => {
  const file = tmpFile();
  appendBatch(file, [{ type: "credit", account: "A", amount: 1000 }]);
  appendBatch(file, [{ type: "trade", id: "r1", buyer: "A", seller: "B", symbol: "S", qty: 10, price: 5 }]);
  appendBatch(file, [{ type: "fill", trade: "r1", qty: 2 }]);
  appendBatch(file, [{ type: "fill", trade: "r1", qty: 3 }]);
  appendBatch(file, [{ type: "fill", trade: "r1", qty: 1 }]);
  appendBatch(file, [{ type: "cancel", trade: "r1" }]);
  appendBatch(file, [{ type: "credit", account: "C", amount: 7 }]);
  appendBatch(file, [{ type: "credit", account: "D", amount: 8 }]);

  const full = computeState(loadChain(file).blocks, 6);
  const ranged = rangeState(file, 5, 6);
  assert.equal(ranged.meta.snapshotSeq, 4, "应命中 <=from 的稀疏索引快照");
  assert.deepEqual(ranged.meta.decodedBlocks, [5, 6], "只解码快照之后的增量区间");
  assert.deepEqual(ranged.state, full, "补齐基础持仓后与全量重放一致");
  assert.equal(ranged.state.positions.A, undefined, "撤销后持仓已回退");
  assert.equal(ranged.state.accounts.A.credit, 970, "6 笔已成交消耗 30, 未成交部分解冻");
  assert.equal(ranged.state.accounts.A.frozen, 0);

  const cli = runCli(["range", file, "--from", "5", "--to", "6"]);
  assert.equal(cli.code, 0);
  assert.deepEqual(cli.json.state, JSON.parse(JSON.stringify(full)));

  const head = rangeState(file, 1, 3);
  assert.equal(head.meta.snapshotSeq, 0);
  assert.deepEqual(head.meta.decodedBlocks, [1, 2, 3]);

  const bad = runCli(["range", file, "--from", "7", "--to", "99"]);
  assert.equal(bad.code, 1);
  assert.equal(bad.json.error.code, "RANGE_BEYOND_TIP");
});
