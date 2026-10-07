import { renderCertificate, renderReplanDiff } from "./certificate.js";
import { loadScenario, MAX_HORIZON } from "./scenario.js";
import { buildSlots, enumerateDayCombos, solveWarehouse } from "./solver.js";
import type { Scenario, WarehouseInput } from "./types.js";
import { checkCertificate, dijkstraOptimum, enumerateOptimum } from "./verify.js";

export const USAGE = `库存规划 CLI（至多 ${MAX_HORIZON} 天需求 / 提前期 / 独立仓容 / 整数下单 / 固定启单费 + 持有费 / 禁止缺货 / 到货在日需求前）

用法:
  node dist/src/cli.js plan <scenario.json>     新计划：最小总费，输出逐日库存证书
  node dist/src/cli.js replan <scenario.json>   重规划：先最少改已公布下单量，再总费少；输出净差与逐日守恒
  node dist/src/cli.js verify <scenario.json>   仅核对：DP / 独立有限状态搜索 / 短周期枚举 三方对照

场景 JSON 见 examples/。退出码: 0 正常, 1 用法或输入错误, 2 不可行。`;

/** 组合空间可承受时才跑短周期枚举对照。 */
function enumerationAffordable(wh: WarehouseInput, horizon: number): boolean {
  if (horizon > 6) return false;
  const slots = buildSlots(wh, horizon);
  const fixed = wh.channels.map((c) => c.fixedCost);
  let product = 1;
  for (let t = 0; t < horizon; t++) {
    product *= enumerateDayCombos(slots[t]!, fixed).length;
    if (product > 2_000_000) return false;
  }
  return true;
}

function solveAndRender(sc: Scenario, replan: boolean): { output: string; feasible: boolean } {
  const parts: string[] = [];
  let feasible = true;
  let grandTotal = 0;
  for (const wh of sc.warehouses) {
    const plan = solveWarehouse(wh, sc.horizon, replan);
    if (!plan) {
      feasible = false;
      parts.push(`── 仓库 ${wh.id}: 不可行（仓容/提前期约束下无法满足需求且禁止缺货）`);
      continue;
    }
    grandTotal += plan.totalCost;
    const violations = checkCertificate(wh, sc.horizon, plan, replan);
    const crossCheck = dijkstraOptimum(wh, sc.horizon, replan);
    const enumeration = enumerationAffordable(wh, sc.horizon)
      ? enumerateOptimum(wh, sc.horizon, replan)
      : null;
    parts.push(renderCertificate(wh, sc.horizon, plan, { replan, violations, crossCheck, enumeration }));
    if (replan) parts.push(renderReplanDiff(wh, sc.horizon, plan));
  }
  if (feasible) {
    parts.push(`══ 全部仓库总费用: ${grandTotal}（各仓容量独立，分别求解后汇总）`);
  }
  return { output: parts.join("\n"), feasible };
}

function verifyOnly(sc: Scenario, replan: boolean): string {
  const lines: string[] = [`核对模式（${replan ? "重规划" : "新计划"}）: 仓库 | DP | 独立有限状态搜索 | 短周期枚举`];
  for (const wh of sc.warehouses) {
    const plan = solveWarehouse(wh, sc.horizon, replan);
    const dp = plan ? `(dev=${plan.deviation}, cost=${plan.totalCost})` : "不可行";
    const dij = dijkstraOptimum(wh, sc.horizon, replan);
    const dijStr = dij ? `(dev=${dij.dev}, cost=${dij.cost})` : "不可行";
    let enumStr = "跳过(规模过大)";
    if (enumerationAffordable(wh, sc.horizon)) {
      const en = enumerateOptimum(wh, sc.horizon, replan);
      enumStr = en ? `(dev=${en.dev}, cost=${en.cost}) [${en.explored} 计划]` : "不可行";
    }
    const cert = plan ? checkCertificate(wh, sc.horizon, plan, replan) : ["不可行"];
    lines.push(`  ${wh.id} | ${dp} | ${dijStr} | ${enumStr} | 证书${cert.length === 0 ? "✓" : "✗ " + cert.join("；")}`);
  }
  return lines.join("\n");
}

export interface CliResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

/** 可被测试直接调用的 CLI 主逻辑。 */
export function run(argv: string[]): CliResult {
  const [command, file] = argv;
  if (!command || !file || !["plan", "replan", "verify"].includes(command)) {
    return { stdout: "", stderr: USAGE + "\n", exitCode: 1 };
  }
  let sc: Scenario;
  try {
    sc = loadScenario(file);
  } catch (err) {
    return { stdout: "", stderr: `${(err as Error).message}\n`, exitCode: 1 };
  }
  const replan = command === "replan";
  if (command === "verify") {
    const hasPublished = sc.warehouses.some((w) => (w.published ?? []).length > 0);
    return { stdout: verifyOnly(sc, hasPublished) + "\n", stderr: "", exitCode: 0 };
  }
  const { output, feasible } = solveAndRender(sc, replan);
  return { stdout: output + "\n", stderr: "", exitCode: feasible ? 0 : 2 };
}

// 作为脚本直接执行时（node dist/src/cli.js ...）
if (process.argv[1] && process.argv[1].endsWith("cli.js")) {
  const result = run(process.argv.slice(2));
  if (result.stdout) process.stdout.write(result.stdout);
  if (result.stderr) process.stderr.write(result.stderr);
  if (result.exitCode !== 0) process.exit(result.exitCode);
}
