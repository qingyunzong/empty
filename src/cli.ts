import { readFileSync, writeSync } from "node:fs";
import { orderCost, unitPriceFor } from "./pricing.js";
import {
  enumerateProcurement,
  enumerationSize,
  solveProcurement,
} from "./procurement.js";
import {
  bruteForceSchedule,
  bruteForceSize,
  solveSchedule,
} from "./schedule.js";
import type {
  ProcurementInput,
  ProcurementResult,
  ScheduleInput,
  ScheduleResult,
  Slot,
} from "./types.js";
import { validateProcurement, validateSchedule } from "./validate.js";

const VERIFY_BUDGET = 5_000_000;

function printOut(s: string): void {
  writeSync(1, s);
}

function printErr(s: string): void {
  writeSync(2, s);
}

interface FullInput extends ProcurementInput {
  slots?: Slot[];
  quantities?: number[];
}

function usage(): number {
  const lines = [
    "用法:",
    "  procure solve <file.json> [--verify] [--json]     采购优化（DP，可用枚举核验）",
    "  procure schedule <file.json> [--verify] [--json]  分时段配送（联合DP，可用穷举核验）",
    "  procure run <file.json> [--verify] [--json]       先采购后排程",
  ];
  printErr(lines.join("\n") + "\n");
  return 2;
}

function readInput(file: string): FullInput {
  let raw: string;
  try {
    raw = readFileSync(file, "utf8");
  } catch {
    throw new Error(`无法读取文件: ${file}`);
  }
  try {
    return JSON.parse(raw) as FullInput;
  } catch {
    throw new Error(`文件不是合法 JSON: ${file}`);
  }
}

function fmtMoney(x: number): string {
  return (Math.round(x * 100) / 100).toFixed(2);
}

function printProcurement(input: ProcurementInput, res: ProcurementResult): void {
  const out: string[] = [];
  out.push(`需求: ${input.demand}  总量上限: ${input.maxTotal}`);
  if (!res.feasible) {
    out.push("无可行解：约束（互斥/依赖/上限/最低起订量）下无法满足需求。");
  } else {
    out.push(`下单向量: [${res.quantities.join(", ")}]`);
    res.quantities.forEach((q, i) => {
      const s = input.suppliers[i];
      if (s !== undefined && q > 0) {
        out.push(
          `  ${s.name}: ${q} 件 × ${fmtMoney(unitPriceFor(s, q))} = ${fmtMoney(orderCost(s, q))}`,
        );
      }
    });
    out.push(`总量: ${res.totalQuantity}  超购: ${res.overPurchase}  总价: ${fmtMoney(res.totalCost)}`);
  }
  printOut(out.join("\n") + "\n");
}

function printSchedule(res: ScheduleResult): void {
  const out: string[] = [];
  if (!res.feasible) {
    out.push("配送不可行：时段容量无法容纳全部到货。");
  } else {
    out.push(`配送方案（供应商→时段）: [${res.assignment.join(", ")}]`);
    out.push("逐时段缺货验证:");
    for (const s of res.slots) {
      const detail = s.deliveries.map((d) => `S${d.supplier}×${d.quantity}`).join(" ") || "-";
      out.push(
        `  时段${s.slot}: 到货[${detail}] 负载 ${s.load}/${s.capacity}` +
        `  累计到货 ${s.cumArrival}  累计需求 ${s.cumDemand}  缺货 ${s.shortage}`,
      );
    }
    out.push(`总缺货: ${res.totalShortage}`);
  }
  printOut(out.join("\n") + "\n");
}

function verifyProcurement(input: ProcurementInput, res: ProcurementResult): string {
  const size = enumerationSize(input);
  if (size > VERIFY_BUDGET) {
    return `枚举核验: 跳过（组合数 ${size} 超过预算 ${VERIFY_BUDGET}）`;
  }
  const ref = enumerateProcurement(input);
  const same =
    ref.feasible === res.feasible &&
    ref.totalCost === res.totalCost &&
    ref.totalQuantity === res.totalQuantity &&
    ref.quantities.join(",") === res.quantities.join(",");
  if (!same) {
    throw new Error(
      `枚举核验不一致: DP=${JSON.stringify(res)} 枚举=${JSON.stringify(ref)}`,
    );
  }
  return `枚举核验: 一致（枚举 ${size} 个组合）`;
}

function verifySchedule(input: ScheduleInput, res: ScheduleResult): string {
  const size = bruteForceSize(input);
  if (size > VERIFY_BUDGET) {
    return `穷举核验: 跳过（组合数 ${size} 超过预算 ${VERIFY_BUDGET}）`;
  }
  const ref = bruteForceSchedule(input);
  const same =
    ref.feasible === res.feasible &&
    ref.totalShortage === res.totalShortage &&
    ref.assignment.join(",") === res.assignment.join(",");
  if (!same) {
    throw new Error(
      `穷举核验不一致: DP=${JSON.stringify(res)} 穷举=${JSON.stringify(ref)}`,
    );
  }
  return `穷举核验: 一致（枚举 ${size} 种分配）`;
}

function main(argv: string[]): number {
  const [cmd, file, ...rest] = argv;
  if (cmd === undefined || file === undefined) return usage();
  const verify = rest.includes("--verify");
  const asJson = rest.includes("--json");
  const input = readInput(file);

  switch (cmd) {
    case "solve": {
      validateProcurement(input);
      const res = solveProcurement(input);
      if (asJson) {
        printOut(JSON.stringify(res, null, 2) + "\n");
      } else {
        printProcurement(input, res);
        if (verify) printOut(verifyProcurement(input, res) + "\n");
      }
      return res.feasible ? 0 : 1;
    }
    case "schedule": {
      const sched: ScheduleInput = {
        quantities: input.quantities ?? [],
        slots: input.slots ?? [],
      };
      validateSchedule(sched);
      const res = solveSchedule(sched);
      if (asJson) {
        printOut(JSON.stringify(res, null, 2) + "\n");
      } else {
        printSchedule(res);
        if (verify) printOut(verifySchedule(sched, res) + "\n");
      }
      return res.feasible ? 0 : 1;
    }
    case "run": {
      validateProcurement(input);
      const proc = solveProcurement(input);
      if (asJson) {
        const sched: ScheduleInput = {
          quantities: proc.quantities,
          slots: input.slots ?? [],
        };
        const schedRes = proc.feasible ? solveSchedule(sched) : null;
        printOut(
          JSON.stringify({ procurement: proc, schedule: schedRes }, null, 2) + "\n",
        );
        return proc.feasible && (schedRes?.feasible ?? false) ? 0 : 1;
      }
      printProcurement(input, proc);
      if (!proc.feasible) return 1;
      if (verify) printOut(verifyProcurement(input, proc) + "\n");
      const sched: ScheduleInput = {
        quantities: proc.quantities,
        slots: input.slots ?? [],
      };
      validateSchedule(sched);
      const schedRes = solveSchedule(sched);
      printSchedule(schedRes);
      if (verify) printOut(verifySchedule(sched, schedRes) + "\n");
      return schedRes.feasible ? 0 : 1;
    }
    default:
      return usage();
  }
}

try {
  process.exitCode = main(process.argv.slice(2));
} catch (err) {
  printErr(`错误: ${err instanceof Error ? err.message : String(err)}\n`);
  process.exitCode = 1;
}
