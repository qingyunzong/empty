import { Problem, Solution, evaluate } from "./types.js";

/** 单条约束证书：id 标识约束，ok 为核验结论，detail 给出人类可读的数值证据。 */
export interface Certificate {
  id: string;
  ok: boolean;
  detail: string;
}

export interface Verification {
  ok: boolean;
  certs: Certificate[];
}

/** 为解 s 逐条生成约束证书（用量、组合、同档/分档、收益合计）。 */
export function buildCertificates(p: Problem, s: Solution): Certificate[] {
  const certs: Certificate[] = [];
  for (let u = 0; u < p.users.length; u++) {
    const t = s.assign[u];
    const tier = p.users[u][t];
    certs.push({
      id: `user:${u}`,
      ok: Number.isInteger(t) && t >= 0 && t < p.users[u].length,
      detail: tier
        ? `用户${u} 选档 ${t}（合法范围 0..${p.users[u].length - 1}），消耗 r1=${tier.r1} r2=${tier.r2}，收益 ${tier.profit}`
        : `用户${u} 的档 ${t} 越界（合法范围 0..${p.users[u].length - 1}）`,
    });
  }
  certs.push({
    id: "budget:1",
    ok: s.used1 <= p.budget1,
    detail: `资源1 用量 ${s.used1} ≤ 预算 ${p.budget1}${s.used1 <= p.budget1 ? "，满足" : "，违反"}`,
  });
  certs.push({
    id: "budget:2",
    ok: s.used2 <= p.budget2,
    detail: `资源2 用量 ${s.used2} ≤ 预算 ${p.budget2}${s.used2 <= p.budget2 ? "，满足" : "，违反"}`,
  });
  p.combos.forEach((c, k) => {
    const hit = s.assign[c.i] === c.ti && s.assign[c.j] === c.tj;
    certs.push({
      id: `combo:${k}`,
      ok: true,
      detail: hit
        ? `组合${k}：用户${c.i}=档${c.ti} 且 用户${c.j}=档${c.tj}，奖励 ${c.bonus} 已计入`
        : `组合${k}：需用户${c.i}=档${c.ti} 且 用户${c.j}=档${c.tj}，实际为档${s.assign[c.i]}/档${s.assign[c.j]}，奖励不计入`,
    });
  });
  p.sameTier.forEach(([i, j], k) => {
    const okc = s.assign[i] === s.assign[j];
    certs.push({
      id: `same:${k}`,
      ok: okc,
      detail: `同档约束${k}：用户${i}=档${s.assign[i]}，用户${j}=档${s.assign[j]}，${okc ? "相同，满足" : "不同，违反"}`,
    });
  });
  p.diffTier.forEach(([i, j], k) => {
    const okc = s.assign[i] !== s.assign[j];
    certs.push({
      id: `diff:${k}`,
      ok: okc,
      detail: `分档约束${k}：用户${i}=档${s.assign[i]}，用户${j}=档${s.assign[j]}，${okc ? "不同，满足" : "相同，违反"}`,
    });
  });
  certs.push({
    id: "profit:sum",
    ok: s.profit === s.baseProfit + s.comboProfit,
    detail: `总收益 ${s.profit} = 档位收益 ${s.baseProfit} + 组合收益 ${s.comboProfit}`,
  });
  return certs;
}

/**
 * 独立核验：由 assign 重新计算全部汇总值并逐条检查证书，
 * 不信任 s 中除 assign 外的任何字段。
 */
export function verifyCertificates(p: Problem, s: Solution): Verification {
  const certs = buildCertificates(p, s);
  let recomputedOk = true;
  let detail = "";
  try {
    const r = evaluate(p, s.assign);
    recomputedOk =
      r.profit === s.profit && r.baseProfit === s.baseProfit && r.comboProfit === s.comboProfit &&
      r.used1 === s.used1 && r.used2 === s.used2 && r.highCount === s.highCount;
    detail = recomputedOk
      ? "解的汇总值（收益/用量/高档人数）与由分配向量独立重算一致"
      : `解的汇总值与重算不一致：声明 profit=${s.profit} used=(${s.used1},${s.used2}) high=${s.highCount}，重算 profit=${r.profit} used=(${r.used1},${r.used2}) high=${r.highCount}`;
  } catch (e) {
    recomputedOk = false;
    detail = `分配向量非法：${(e as Error).message}`;
  }
  certs.push({ id: "consistency", ok: recomputedOk, detail });
  return { ok: certs.every((c) => c.ok), certs };
}
