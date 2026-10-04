import { readFileSync } from "node:fs";
import type { Instance, InstanceSpec, StationSpec } from "./types.js";

function isNum(v: unknown): v is number {
  return typeof v === "number" && Number.isFinite(v);
}

function checkStation(s: StationSpec, i: number): void {
  if (typeof s.id !== "string" || s.id.length === 0) throw new Error(`站点 ${i}: id 缺失`);
  for (const k of ["x", "y", "service", "open", "close", "profit"] as const) {
    if (!isNum(s[k])) throw new Error(`站点 ${s.id}: 字段 ${k} 非法`);
  }
  if (s.service < 0) throw new Error(`站点 ${s.id}: service 不能为负`);
  if (s.open > s.close) throw new Error(`站点 ${s.id}: 时间窗 open > close`);
}

/** 校验并编译实例：构建距离矩阵（欧氏距离，速度 1，时间=路程）。 */
export function compileInstance(spec: InstanceSpec): Instance {
  if (!isNum(spec.timeLimit) || spec.timeLimit < 0) throw new Error("timeLimit 非法");
  if (!spec.depot || !isNum(spec.depot.x) || !isNum(spec.depot.y)) throw new Error("depot 非法");
  if (!Array.isArray(spec.stations)) throw new Error("stations 必须是数组");
  const n = spec.stations.length;
  if (n > 16) throw new Error(`站点数 ${n} 超过上限 16`);
  spec.stations.forEach(checkStation);

  const xs = [spec.depot.x, ...spec.stations.map((s) => s.x)];
  const ys = [spec.depot.y, ...spec.stations.map((s) => s.y)];
  const dist: number[][] = [];
  for (let i = 0; i <= n; i++) {
    const row: number[] = [];
    for (let j = 0; j <= n; j++) {
      row.push(Math.hypot(xs[i]! - xs[j]!, ys[i]! - ys[j]!));
    }
    dist.push(row);
  }
  return {
    name: spec.name ?? "unnamed",
    timeLimit: spec.timeLimit,
    n,
    service: [0, ...spec.stations.map((s) => s.service)],
    open: [0, ...spec.stations.map((s) => s.open)],
    close: [Infinity, ...spec.stations.map((s) => s.close)],
    profit: [0, ...spec.stations.map((s) => s.profit)],
    ids: ["BASE", ...spec.stations.map((s) => s.id)],
    dist,
  };
}

export function loadInstance(path: string): Instance {
  const raw = readFileSync(path, "utf8");
  return compileInstance(JSON.parse(raw) as InstanceSpec);
}
