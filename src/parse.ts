import { MAX_PACKAGES, Problem } from "./types.js";

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function need(cond: boolean, msg: string): asserts cond {
  if (!cond) throw new Error(`输入非法: ${msg}`);
}

function needNonEmptyString(v: unknown, field: string): string {
  need(typeof v === "string" && v.length > 0, `${field} 必须是非空字符串`);
  return v as string;
}

function needInt(v: unknown, field: string, min: number): number {
  need(typeof v === "number" && Number.isInteger(v) && v >= min, `${field} 必须是 >= ${min} 的整数`);
  return v as number;
}

/** 校验并规范化原始 JSON 为 Problem；非法时抛出带中文说明的 Error。 */
export function parseProblem(raw: unknown): Problem {
  need(isRecord(raw), "顶层必须是 JSON 对象");
  const start = needNonEmptyString(raw.start, "start");
  const target = needNonEmptyString(raw.target, "target");
  const spaceLimit = needInt(raw.spaceLimit, "spaceLimit", 0);
  need(Array.isArray(raw.packages), "packages 必须是数组");
  const list = raw.packages as unknown[];
  need(list.length <= MAX_PACKAGES, `packages 至多 ${MAX_PACKAGES} 个（当前 ${list.length} 个）`);
  const seen = new Set<string>();
  const packages = list.map((item, i) => {
    need(isRecord(item), `packages[${i}] 必须是对象`);
    const id = needNonEmptyString(item.id, `packages[${i}].id`);
    need(!seen.has(id), `包 ID 重复: ${id}`);
    seen.add(id);
    return {
      id,
      from: needNonEmptyString(item.from, `packages[${i}].from`),
      to: needNonEmptyString(item.to, `packages[${i}].to`),
      bytes: needInt(item.bytes, `packages[${i}].bytes`, 1),
      peak: needInt(item.peak, `packages[${i}].peak`, 0),
    };
  });
  return { start, target, spaceLimit, packages };
}
