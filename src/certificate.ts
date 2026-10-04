import { EPS, type Certificate, type Instance, type SolveResult } from "./types.js";
import { simulateRoute } from "./route.js";

const round = (x: number): number => Math.round(x * 1e6) / 1e6;

/** 由求解结果生成到离时刻证书。 */
export function buildCertificate(inst: Instance, res: SolveResult): Certificate {
  const sim = simulateRoute(inst, res.route);
  if (!sim.feasible) throw new Error("求解器产生了不可行路线");
  return {
    instance: inst.name,
    timeLimit: inst.timeLimit,
    profit: round(sim.profit),
    distance: round(sim.distance),
    totalTime: round(sim.totalTime),
    legs: sim.legs.map((l) => ({
      ...l,
      arrive: round(l.arrive),
      wait: round(l.wait),
      start: round(l.start),
      depart: round(l.depart),
    })),
  };
}

const TOL = 1e-4;

/**
 * 独立校验证书：只根据证书里的站点顺序重算全部到离时刻，
 * 核对时间窗、等待、服务、总时限、收益与路程是否自洽。
 */
export function verifyCertificate(inst: Instance, cert: Certificate): string[] {
  const errors: string[] = [];
  const idToIdx = new Map(inst.ids.map((id, i) => [id, i]));
  const legs = cert.legs;
  if (legs.length < 2) errors.push("证书至少包含出发与返回两条记录");
  if (legs[0]?.node !== inst.ids[0]) errors.push("首条记录必须是基地");
  if (legs[legs.length - 1]?.node !== inst.ids[0]) errors.push("末条记录必须是返回基地");

  const order: number[] = [];
  for (let i = 1; i < legs.length - 1; i++) {
    const idx = idToIdx.get(legs[i]!.node);
    if (idx === undefined || idx === 0) {
      errors.push(`第 ${i} 条记录站点未知: ${legs[i]!.node}`);
      continue;
    }
    order.push(idx);
  }
  const dup = new Set(order);
  if (dup.size !== order.length) errors.push("存在重复访问的站点");

  const sim = simulateRoute(inst, order);
  if (!sim.feasible) errors.push("路线本身不可行（时间窗或总时限被违反）");

  // 逐条核对证书申报的到离时刻与重算结果
  const n = Math.min(legs.length, sim.legs.length);
  for (let i = 0; i < n; i++) {
    const a = legs[i]!;
    const b = sim.legs[i]!;
    if (a.node !== b.node) {
      errors.push(`第 ${i} 条记录节点不符: 证书 ${a.node} != 重算 ${b.node}`);
      continue;
    }
    for (const k of ["arrive", "wait", "start", "depart"] as const) {
      if (Math.abs(a[k] - b[k]) > TOL) {
        errors.push(`${a.node} 的 ${k}: 证书 ${a[k]} != 重算 ${b[k]}`);
      }
    }
    if (a.window && (a.start < a.window[0] - TOL || a.start > a.window[1] + TOL)) {
      errors.push(`${a.node} 开始服务时刻 ${a.start} 不在窗口 [${a.window[0]}, ${a.window[1]}]`);
    }
  }

  if (Math.abs(cert.profit - sim.profit) > TOL) errors.push(`收益不符: 证书 ${cert.profit} != 重算 ${sim.profit}`);
  if (Math.abs(cert.distance - sim.distance) > TOL) errors.push(`路程不符: 证书 ${cert.distance} != 重算 ${round(sim.distance)}`);
  if (Math.abs(cert.totalTime - sim.totalTime) > TOL) errors.push(`总耗时不符: 证书 ${cert.totalTime} != 重算 ${round(sim.totalTime)}`);
  if (cert.totalTime > inst.timeLimit + TOL) errors.push(`总耗时 ${cert.totalTime} 超过时限 ${inst.timeLimit}`);
  if (cert.timeLimit !== inst.timeLimit) errors.push(`证书时限 ${cert.timeLimit} 与实例 ${inst.timeLimit} 不一致`);
  return errors;
}

const f2 = (x: number): string => x.toFixed(2);

/** 人类可读的证书文本。 */
export function formatCertificate(cert: Certificate): string {
  const lines: string[] = [];
  lines.push(`实例: ${cert.instance}    时限: ${cert.timeLimit}`);
  lines.push(`收益: ${cert.profit}    路程: ${f2(cert.distance)}    总耗时: ${f2(cert.totalTime)}`);
  lines.push("到离时刻证书:");
  lines.push("  节点        到达      等待  开始服务      离开  时间窗            收益");
  for (const leg of cert.legs) {
    const win = leg.window ? `[${f2(leg.window[0])}, ${f2(leg.window[1])}]` : "-";
    const profit = leg.profit !== undefined ? String(leg.profit) : "-";
    lines.push(
      `  ${leg.node.padEnd(8)} ${f2(leg.arrive).padStart(8)} ${f2(leg.wait).padStart(8)} ${f2(leg.start).padStart(8)} ${f2(leg.depart).padStart(8)}  ${win.padEnd(18)} ${profit}`,
    );
  }
  return lines.join("\n");
}
