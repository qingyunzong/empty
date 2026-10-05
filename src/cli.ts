import { readFileSync } from "node:fs";
import process from "node:process";
import { parseSpec } from "./model.js";
import { solve, type SolveResult } from "./solve.js";

const USAGE = `用法: policy-diff <输入.json | -> [--budget N]

在有限属性域上寻找使两个策略决议不同的最小属性赋值。

输入 JSON:
  attributes  属性名 -> 有限取值数组（数组顺序即取值序）
  policies    恰好两个策略，每个含 default 与至多 20 条规则
              规则形如 { "when": { 属性: 取值, ... }, "decision": "..." }，按序首条命中生效
  budget      可选，求值预算（默认 1000000）

退出码: 0 = 已得结论（DIFFERENT/EQUIVALENT），3 = 预算耗尽未决（UNDECIDED），1 = 输入错误
`;

function printResult(result: SolveResult): void {
  if (result.verdict === "DIFFERENT" && result.witness) {
    const w = result.witness;
    process.stdout.write(`结论: DIFFERENT — 找到最小差异赋值（已指定字段 ${w.specifiedFields} 个）\n`);
    for (const [attr, value] of Object.entries(w.assignment)) {
      process.stdout.write(`  ${attr} = ${value}\n`);
    }
    for (const [policy, decision] of Object.entries(w.decisions)) {
      process.stdout.write(`  策略 ${policy} 决议: ${decision}\n`);
    }
  } else if (result.verdict === "EQUIVALENT") {
    process.stdout.write("结论: EQUIVALENT — 已穷尽全部属性赋值，两策略决议始终一致\n");
  } else {
    process.stdout.write("结论: UNDECIDED — 预算耗尽，尚未找到差异也未穷尽空间\n");
  }
  process.stdout.write(
    `统计: 已求值 ${result.evaluated} / 空间 ${result.spaceSize}（预算 ${result.budget}），` +
      `枚举核对 ok，求值核对 ${result.crossCheck.evaluation}\n`
  );
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}

export function run(argv: string[]): number {
  const args: string[] = [];
  let budgetOverride: number | undefined;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (arg === "--help" || arg === "-h") {
      process.stdout.write(USAGE);
      return 0;
    }
    if (arg === "--budget") {
      const raw = argv[++i];
      const parsed = raw === undefined ? NaN : Number(raw);
      if (!Number.isInteger(parsed) || parsed < 1) {
        process.stderr.write("错误: --budget 需要正整数\n");
        return 1;
      }
      budgetOverride = parsed;
      continue;
    }
    args.push(arg);
  }
  if (args.length !== 1) {
    process.stderr.write(USAGE);
    return 1;
  }
  let text: string;
  try {
    text = readFileSync(args[0] === "-" ? 0 : args[0]!, "utf8");
  } catch {
    process.stderr.write(`错误: 无法读取输入文件 ${args[0]}\n`);
    return 1;
  }
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    process.stderr.write("错误: 输入不是合法 JSON\n");
    return 1;
  }
  try {
    const spec = parseSpec(raw);
    if (budgetOverride !== undefined) spec.budget = budgetOverride;
    const result = solve(spec);
    printResult(result);
    return result.verdict === "UNDECIDED" ? 3 : 0;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`错误: ${message}\n`);
    return message.startsWith("交叉核对失败") ? 4 : 1;
  }
}

process.exitCode = run(process.argv.slice(2));
