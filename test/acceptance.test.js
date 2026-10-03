import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { appendBatch, computeState, loadChain, rangeState } from "../lib/store.js";
import { tmpFile, runCli } from "./helpers.js";

function referenceModel(batches) {
  const accounts = {};
  const positions = {};
  const trades = {};
  const acc = (n) => (accounts[n] ??= { credit: 0, frozen: 0 });
  const pos = (a, s, d) => {
    const book = (positions[a] ??= {});
    book[s] = (book[s] ?? 0) + d;
    if (book[s] === 0) delete book[s];
    if (Object.keys(book).length === 0) delete positions[a];
  };
  for (const rec of batches.flat()) {
    if (rec.type === "credit") {
      acc(rec.account).credit += rec.amount;
    } else if (rec.type === "trade") {
      const cost = rec.qty * rec.price;
      acc(rec.buyer).credit -= cost;
      acc(rec.buyer).frozen += cost;
      acc(rec.seller);
      trades[rec.id] = { ...rec, filled: 0, status: "open" };
      delete trades[rec.id].type;
    } else if (rec.type === "fill") {
      const t = trades[rec.trade];
      t.filled += rec.qty;
      pos(t.buyer, t.symbol, rec.qty);
      pos(t.seller, t.symbol, -rec.qty);
      acc(t.buyer).frozen -= rec.qty * t.price;
      if (t.filled === t.qty) t.status = "filled";
    } else if (rec.type === "cancel") {
      const t = trades[rec.trade];
      const remaining = (t.qty - t.filled) * t.price;
      acc(t.buyer).frozen -= remaining;
      acc(t.buyer).credit += remaining;
      if (t.filled > 0) {
        pos(t.buyer, t.symbol, -t.filled);
        pos(t.seller, t.symbol, t.filled);
      }
      t.status = "cancelled";
    }
  }
  return { accounts, positions, trades };
}

const CREDITS = [
  { type: "credit", account: "B1", amount: 1000 },
  { type: "credit", account: "B2", amount: 500 },
  { type: "credit", account: "B3", amount: 300 },
];

const TRADES = [
  { type: "trade", id: "t1", buyer: "B1", seller: "S1", symbol: "X", qty: 10, price: 10 },
  { type: "trade", id: "t2", buyer: "B2", seller: "S2", symbol: "X", qty: 5, price: 20 },
  { type: "trade", id: "t3", buyer: "B1", seller: "S1", symbol: "Y", qty: 4, price: 25 },
  { type: "trade", id: "t4", buyer: "B3", seller: "S2", symbol: "X", qty: 3, price: 30 },
  { type: "trade", id: "t5", buyer: "B2", seller: "S1", symbol: "Y", qty: 2, price: 15 },
  { type: "trade", id: "t6", buyer: "B1", seller: "S2", symbol: "Y", qty: 6, price: 5 },
  { type: "trade", id: "t7", buyer: "B3", seller: "S1", symbol: "X", qty: 1, price: 40 },
  { type: "trade", id: "t8", buyer: "B2", seller: "S2", symbol: "X", qty: 8, price: 5 },
];

const FILLS = [
  { type: "fill", trade: "t1", qty: 4 },
  { type: "fill", trade: "t2", qty: 5 },
  { type: "fill", trade: "t1", qty: 3 },
  { type: "fill", trade: "t3", qty: 2 },
  { type: "fill", trade: "t4", qty: 3 },
  { type: "fill", trade: "t6", qty: 2 },
  { type: "fill", trade: "t8", qty: 1 },
  { type: "fill", trade: "t6", qty: 2 },
];

const CANCELS = ["t1", "t3", "t5"];

function permutations(items) {
  if (items.length <= 1) return [items];
  const out = [];
  for (let i = 0; i < items.length; i++) {
    const rest = [...items.slice(0, i), ...items.slice(i + 1)];
    for (const perm of permutations(rest)) out.push([items[i], ...perm]);
  }
  return out;
}

function baseBatches() {
  return [CREDITS, TRADES.slice(0, 4), TRADES.slice(4), FILLS.slice(0, 4), FILLS.slice(4)];
}

test("验收1: 8笔交易+部分成交, 枚举所有撤销到达顺序与参考模型比对", () => {
  const orders = permutations(CANCELS);
  assert.equal(orders.length, 6);
  for (const order of orders) {
    const file = tmpFile();
    const batches = [...baseBatches(), ...order.map((id) => [{ type: "cancel", trade: id }])];
    for (const batch of batches) appendBatch(file, batch);
    const state = computeState(loadChain(file).blocks);
    const expected = referenceModel(batches);
    assert.deepEqual(
      { accounts: state.accounts, positions: state.positions, trades: state.trades },
      expected,
      `撤销顺序 ${order.join(",")} 的最终持仓与授信不一致`,
    );
    const replay = runCli(["replay", file]);
    assert.equal(replay.code, 0);
    assert.deepEqual(replay.json.state.accounts, expected.accounts);
    assert.deepEqual(replay.json.state.positions, expected.positions);
  }
});

test("验收1补充: 全额撤销后成交被拒, 超量成交与授信不足均被拒", () => {
  const file = tmpFile();
  for (const batch of baseBatches()) appendBatch(file, batch);
  appendBatch(file, [{ type: "cancel", trade: "t5" }]);

  const fillAfterCancel = runCli(["put", file, "--json", JSON.stringify([{ type: "fill", trade: "t5", qty: 1 }])]);
  assert.equal(fillAfterCancel.code, 1);
  assert.equal(fillAfterCancel.json.error.code, "TRADE_CANCELLED");

  const overfill = runCli(["put", file, "--json", JSON.stringify([{ type: "fill", trade: "t2", qty: 1 }])]);
  assert.equal(overfill.code, 1);
  assert.equal(overfill.json.error.code, "TRADE_FILLED");

  const broke = runCli([
    "put", file, "--json",
    JSON.stringify([{ type: "trade", id: "t9", buyer: "B3", seller: "S1", symbol: "X", qty: 100, price: 100 }]),
  ]);
  assert.equal(broke.code, 1);
  assert.equal(broke.json.error.code, "INSUFFICIENT_CREDIT");

  const dup = runCli([
    "put", file, "--json",
    JSON.stringify([{ type: "trade", id: "t1", buyer: "B1", seller: "S1", symbol: "X", qty: 1, price: 1 }]),
  ]);
  assert.equal(dup.code, 1);
  assert.equal(dup.json.error.code, "DUPLICATE_TRADE");

  const recancel = runCli(["cancel", file, "t5"]);
  assert.equal(recancel.code, 1);
  assert.equal(recancel.json.error.code, "ALREADY_CANCELLED");
});
