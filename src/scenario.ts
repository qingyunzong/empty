import { readFileSync } from "node:fs";
import type { Scenario, WarehouseInput } from "./types.js";

export const MAX_HORIZON = 12;

const isInt = (v: unknown): v is number => typeof v === "number" && Number.isInteger(v);
const isNum = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);

function fail(msg: string): never {
  throw new Error(`场景文件非法: ${msg}`);
}

function checkWarehouse(raw: unknown, index: number): WarehouseInput {
  const w = raw as Record<string, unknown>;
  const at = `warehouses[${index}]`;
  if (typeof w !== "object" || w === null) fail(`${at} 不是对象`);
  if (typeof w.id !== "string" || w.id.length === 0) fail(`${at}.id 缺失`);
  if (!isInt(w.capacity) || w.capacity <= 0) fail(`${at}.capacity 必须为正整数`);
  if (!isInt(w.initialInventory) || w.initialInventory < 0 || w.initialInventory > w.capacity) {
    fail(`${at}.initialInventory 必须为 [0, capacity] 内整数`);
  }
  if (!isNum(w.holdingCost) || w.holdingCost < 0) fail(`${at}.holdingCost 必须为非负数`);
  if (!Array.isArray(w.demand) || w.demand.length === 0) fail(`${at}.demand 必须为非空数组`);
  for (const d of w.demand) {
    if (!isInt(d) || d < 0) fail(`${at}.demand 含非负整数以外的值`);
  }
  if (!Array.isArray(w.channels) || w.channels.length === 0) fail(`${at}.channels 必须为非空数组`);
  const names = new Set<string>();
  const channels = (w.channels as Record<string, unknown>[]).map((c, ci) => {
    if (typeof c.name !== "string" || c.name.length === 0) fail(`${at}.channels[${ci}].name 缺失`);
    if (names.has(c.name)) fail(`${at} 渠道名重复: ${c.name}`);
    names.add(c.name);
    if (!isInt(c.leadTime) || c.leadTime < 0) fail(`${at}.channels[${ci}].leadTime 必须为非负整数`);
    if (!isNum(c.fixedCost) || c.fixedCost < 0) fail(`${at}.channels[${ci}].fixedCost 必须为非负数`);
    return { name: c.name, leadTime: c.leadTime, fixedCost: c.fixedCost };
  });
  const published = (w.published as Record<string, unknown>[] | undefined) ?? [];
  if (!Array.isArray(published)) fail(`${at}.published 必须为数组`);
  for (const [pi, o] of published.entries()) {
    if (!isInt(o.day) || !isInt(o.qty) || !isInt(o.locked)) fail(`${at}.published[${pi}] 字段须为整数`);
    if (typeof o.channel !== "string" || !names.has(o.channel)) {
      fail(`${at}.published[${pi}].channel 未知: ${String(o.channel)}`);
    }
    if (o.qty < 0 || o.locked < 0 || o.locked > o.qty) {
      fail(`${at}.published[${pi}] 须满足 0 <= locked <= qty`);
    }
  }
  return {
    id: w.id,
    capacity: w.capacity,
    initialInventory: w.initialInventory,
    holdingCost: w.holdingCost,
    demand: w.demand as number[],
    channels,
    published: published as unknown as WarehouseInput["published"],
  };
}

export function validateScenario(raw: unknown): Scenario {
  const s = raw as Record<string, unknown>;
  if (typeof s !== "object" || s === null) fail("顶层不是对象");
  if (!isInt(s.horizon) || s.horizon < 1 || s.horizon > MAX_HORIZON) {
    fail(`horizon 必须为 1..${MAX_HORIZON} 的整数（至多 ${MAX_HORIZON} 天需求）`);
  }
  if (!Array.isArray(s.warehouses) || s.warehouses.length === 0) fail("warehouses 必须为非空数组");
  const warehouses = s.warehouses.map((w, i) => checkWarehouse(w, i));
  for (const w of warehouses) {
    if (w.demand.length !== s.horizon) {
      fail(`仓库 ${w.id} 的 demand 长度 ${w.demand.length} ≠ horizon ${s.horizon}`);
    }
  }
  return { horizon: s.horizon, warehouses };
}

export function loadScenario(path: string): Scenario {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch {
    throw new Error(`无法读取场景文件: ${path}`);
  }
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new Error(`场景文件不是合法 JSON: ${path}`);
  }
  return validateScenario(raw);
}
