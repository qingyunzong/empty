#!/usr/bin/env node
/**
 * 配比 CLI：从 <=12 种液体中选整数单位量（总量 <= 40），
 * 使混合浓度落在有理闭区间内；先最小化整数成本，再取用量向量字典序最小。
 *
 * 用法:
 *   node dist/src/cli.js [--json] [config.json|-]
 *
 * 输入 JSON（文件路径或标准输入 "-"，缺省读标准输入）:
 * {
 *   "liquids": [ { "concentration": "1/2", "cost": 3 }, ... ],   // 1..12 种
 *   "target": ["1/3", "2/5"],                                    // 闭区间 [lo, hi]
 *   "maxTotal": 40                                               // 可选，默认 40，上限 40
 * }
 * 浓度/区间支持 "p/q"、整数、有限小数；成本为非负整数。
 */
import { readFileSync } from "node:fs";
import { parseFraction, formatFraction, cmp, type Fraction } from "./fraction.js";
import { solve, MAX_LIQUIDS, MAX_TOTAL, type Liquid } from "./solver.js";

function fail(msg: string): never {
  console.error(`错误: ${msg}`);
  process.exit(2);
}

function parseRational(v: unknown, what: string): Fraction {
  if (typeof v === "number" && Number.isInteger(v)) return parseFraction(String(v));
  if (typeof v === "string") {
    try {
      return parseFraction(v);
    } catch {
      fail(`${what} 不是合法有理数: ${v}`);
    }
  }
  fail(`${what} 须为 "p/q"、整数或有限小数字符串`);
}

function parseCost(v: unknown, what: string): bigint {
  if (typeof v === "number" && Number.isSafeInteger(v) && v >= 0) return BigInt(v);
  if (typeof v === "string" && /^\d+$/.test(v)) return BigInt(v);
  fail(`${what} 须为非负整数`);
}

const args = process.argv.slice(2);
let jsonOut = false;
const paths: string[] = [];
for (const a of args) {
  if (a === "--json") jsonOut = true;
  else paths.push(a);
}
if (paths.length > 1) fail("至多一个输入文件路径");

let raw: string;
try {
  raw = paths.length === 0 || paths[0] === "-" ? readFileSync(0, "utf8") : readFileSync(paths[0], "utf8");
} catch {
  fail(`无法读取输入: ${paths[0] ?? "stdin"}`);
}

let cfg: any;
try {
  cfg = JSON.parse(raw);
} catch {
  fail("输入不是合法 JSON");
}

if (!cfg || !Array.isArray(cfg.liquids)) fail("缺少 liquids 数组");
if (cfg.liquids.length < 1 || cfg.liquids.length > MAX_LIQUIDS)
  fail(`liquids 数量须为 1..${MAX_LIQUIDS}`);
if (!Array.isArray(cfg.target) || cfg.target.length !== 2) fail('缺少 target: [lo, hi]');

const liquids: Liquid[] = cfg.liquids.map((l: any, i: number) => ({
  concentration: parseRational(l?.concentration, `liquids[${i}].concentration`),
  cost: parseCost(l?.cost, `liquids[${i}].cost`),
}));
const lo = parseRational(cfg.target[0], "target[0]");
const hi = parseRational(cfg.target[1], "target[1]");
if (cmp(lo, hi) > 0) fail("target 下界大于上界");
const maxTotal = cfg.maxTotal === undefined ? MAX_TOTAL : cfg.maxTotal;
if (!Number.isInteger(maxTotal) || maxTotal < 1 || maxTotal > MAX_TOTAL)
  fail(`maxTotal 须为 1..${MAX_TOTAL} 的整数`);

const result = solve(liquids, lo, hi, maxTotal);

if (result === null) {
  if (jsonOut) {
    console.log(JSON.stringify({ solution: null }));
  } else {
    console.log("无解：已完备搜索全部整数组合，不存在满足浓度区间的配比。");
  }
  process.exit(1);
}

const conc = formatFraction(result.concentration);
if (jsonOut) {
  console.log(
    JSON.stringify({
      solution: {
        amounts: result.amounts,
        total: result.total,
        concentration: conc,
        cost: result.cost.toString(),
      },
    }),
  );
} else {
  console.log(`用量: [${result.amounts.join(", ")}]`);
  result.amounts.forEach((a, i) => {
    if (a > 0)
      console.log(
        `  液体 ${i}: ${a} 单位（浓度 ${formatFraction(liquids[i].concentration)}，单位成本 ${liquids[i].cost}）`,
      );
  });
  console.log(`总量: ${result.total}`);
  console.log(`浓度: ${conc}`);
  console.log(`成本: ${result.cost}`);
}
