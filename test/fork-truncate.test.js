import test from "node:test";
import assert from "node:assert/strict";
import { appendFileSync, readFileSync, truncateSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { appendBatch, loadChain } from "../lib/store.js";
import { encodeBlock } from "../lib/format.js";
import { tmpFile, runCli } from "./helpers.js";

const sha = (buf) => createHash("sha256").update(buf).digest("hex");

function seedFile() {
  const file = tmpFile();
  appendBatch(file, [{ type: "credit", account: "A", amount: 1000 }]);
  appendBatch(file, [{ type: "trade", id: "x1", buyer: "A", seller: "B", symbol: "S", qty: 2, price: 10 }]);
  appendBatch(file, [{ type: "fill", trade: "x1", qty: 1 }]);
  return file;
}

test("验收2: 制造分叉后判定 FORK 且无任何状态更新", () => {
  for (const forkSeq of [3, 9]) {
    const file = seedFile();
    const chain = loadChain(file);
    assert.equal(chain.blocks.length, 3);

    const forkBlock = encodeBlock({
      seq: forkSeq,
      prevHash: chain.blocks[1].hash,
      records: [{ type: "credit", account: "EVIL", amount: 999999 }],
    });
    appendFileSync(file, forkBlock);
    const before = sha(readFileSync(file));

    const replay = runCli(["replay", file]);
    assert.equal(replay.code, 2);
    assert.equal(replay.json.error.code, "FORK");
    assert.match(replay.json.error.message, /拒绝自动选择/);

    const verify = runCli(["verify", file]);
    assert.equal(verify.code, 2);
    assert.equal(verify.json.error.code, "FORK");

    const put = runCli(["put", file, "--json", JSON.stringify([{ type: "credit", account: "A", amount: 1 }])]);
    assert.equal(put.code, 2);
    assert.equal(put.json.error.code, "FORK");

    assert.equal(sha(readFileSync(file)), before, "分叉后文件不得有任何状态更新");
  }
});

test("验收3: 截断最后块并重启, 已确认前缀可恢复, 截断事务不存在", () => {
  const file = seedFile();
  const size = readFileSync(file).length;
  truncateSync(file, size - 12);

  const replay = runCli(["replay", file]);
  assert.equal(replay.code, 0);
  assert.equal(replay.json.blocks, 2);
  assert.equal(replay.json.truncated, true);
  assert.equal(replay.json.state.trades.x1.filled, 0, "截断块中的成交不得存在");
  assert.equal(replay.json.state.trades.x1.status, "open");

  const put = runCli(["put", file, "--json", JSON.stringify([{ type: "fill", trade: "x1", qty: 2 }])]);
  assert.equal(put.code, 0);
  assert.equal(put.json.seq, 3, "截断尾部被回滚后在原序号处续写");

  const verify = runCli(["verify", file]);
  assert.equal(verify.code, 0);
  assert.equal(verify.json.truncated, false);
  assert.equal(verify.json.blocks, 3);

  const replay2 = runCli(["replay", file]);
  assert.equal(replay2.json.state.trades.x1.filled, 2);
  assert.equal(replay2.json.state.trades.x1.status, "filled");
});
