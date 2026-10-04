import { readFileSync } from "node:fs";
import { solve, solveBruteForce, Supplier } from "./solver";

interface Config {
  demand: number;
  suppliers: Supplier[];
}

function yuan(cents: number): string {
  const sign = cents < 0 ? "-" : "";
  const abs = Math.abs(cents);
  return `${sign}${Math.floor(abs / 100)}.${String(abs % 100).padStart(2, "0")}`;
}

function usage(): never {
  console.error(
    "usage: node cli.js [config.json] [--demand N] [--brute]\n" +
      "  config.json  defaults to config.sample.json\n" +
      "  --demand N   override demand in config\n" +
      "  --brute      also run full enumeration and cross-check (small demand only)"
  );
  process.exit(2);
}

function validate(config: Config): void {
  if (!Number.isInteger(config.demand) || config.demand < 0) {
    throw new Error(`invalid demand: ${config.demand}`);
  }
  if (!Array.isArray(config.suppliers) || config.suppliers.length === 0) {
    throw new Error("config must contain at least one supplier");
  }
  if (config.suppliers.length > 6) {
    throw new Error(`at most 6 suppliers supported, got ${config.suppliers.length}`);
  }
  for (const s of config.suppliers) {
    if (!s.name) throw new Error("supplier missing name");
    if (!Number.isInteger(s.moq) || s.moq < 1) throw new Error(`${s.name}: invalid moq`);
    if (!Number.isInteger(s.freightThresholdCents) || s.freightThresholdCents < 0)
      throw new Error(`${s.name}: invalid freightThresholdCents`);
    if (!Number.isInteger(s.freightFeeCents) || s.freightFeeCents < 0)
      throw new Error(`${s.name}: invalid freightFeeCents`);
    if (!Array.isArray(s.tiers) || s.tiers.length === 0)
      throw new Error(`${s.name}: tiers must be non-empty`);
    for (const t of s.tiers) {
      if (!Number.isInteger(t.minQty) || t.minQty < 1)
        throw new Error(`${s.name}: invalid tier minQty`);
      if (!Number.isInteger(t.unitPriceCents) || t.unitPriceCents < 0)
        throw new Error(`${s.name}: invalid tier unitPriceCents`);
    }
    const mins = s.tiers.map((t) => t.minQty);
    for (let i = 1; i < mins.length; i++) {
      if (mins[i] <= mins[i - 1]) throw new Error(`${s.name}: tiers must be sorted by minQty`);
    }
  }
}

function main(): void {
  const args = process.argv.slice(2);
  let configPath = "config.sample.json";
  let demandOverride: number | null = null;
  let brute = false;
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === "--demand") {
      demandOverride = Number(args[++i]);
      if (!Number.isInteger(demandOverride) || demandOverride < 0) usage();
    } else if (a === "--brute") {
      brute = true;
    } else if (a.startsWith("-")) {
      usage();
    } else {
      configPath = a;
    }
  }

  const config = JSON.parse(readFileSync(configPath, "utf8")) as Config;
  if (demandOverride !== null) config.demand = demandOverride;
  validate(config);

  const result = solve(config.suppliers, config.demand);

  console.log(`需求总量: ${result.demand}`);
  console.log("");
  console.log("供应商  数量  单价(元)  货款(元)  运费(元)  小计(元)");
  for (const l of result.lines) {
    console.log(
      `${l.supplier}  ${l.qty}  ${yuan(l.unitPriceCents)}  ${yuan(l.goodsCents)}  ${yuan(l.freightCents)}  ${yuan(l.totalCents)}`
    );
  }
  console.log("");
  console.log(`总费用: ${yuan(result.totalCents)} 元 (${result.totalCents} 分)`);
  console.log(`供应商数量: ${result.supplierCount}`);

  if (brute) {
    const check = solveBruteForce(config.suppliers, config.demand);
    const ok =
      check.totalCents === result.totalCents && check.supplierCount === result.supplierCount;
    console.log(
      `全枚举校验: ${ok ? "一致" : "不一致"} (枚举最优 ${check.totalCents} 分 / ${check.supplierCount} 家)`
    );
    if (!ok) process.exit(1);
  }
}

main();
