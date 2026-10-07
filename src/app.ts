import {
  MAX_ORIGINAL_PRICE,
  MAX_STEPS,
  countValues,
  invertChain,
  parseStep,
  verifyLowDomain,
  type Interval,
  type RationalStep,
} from "./core.js";

const DEFAULT_VERIFY_LIMIT = 1_000_000n;

export const USAGE = `用法: quote <目标金额> <折扣步骤...> [选项]

  从舍入后金额反推整数原价区间。每个折扣步骤为正有理数 p/q（或整数 p），
  每步先乘以 p/q，再做最近偶数舍入（round half to even）。
  折扣链最多 ${MAX_STEPS} 步；原价定义域为 [0, 10^12]（可用 --max 调整）。

参数:
  目标金额        非负整数，即折扣链最终舍入后的金额
  折扣步骤...     1 到 ${MAX_STEPS} 个有理数，如 3/4 9/10

选项:
  --max N           原价定义域上界（默认 1000000000000）
  --verify-limit N  低价域逐值前向核验上限（默认 1000000，0 表示跳过核验）
  --json            以 JSON 输出结果
  -h, --help        显示帮助

示例:
  quote 150 3/4 9/10
  quote 0 1/2 1/2 1/2 --json
`;

export interface CliResult {
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
}

interface CliArgs {
  target: bigint;
  steps: RationalStep[];
  max: bigint;
  verifyLimit: bigint;
  json: boolean;
}

class HelpRequested extends Error {}

function parseArgs(argv: readonly string[]): CliArgs {
  const positional: string[] = [];
  let max = MAX_ORIGINAL_PRICE;
  let verifyLimit = DEFAULT_VERIFY_LIMIT;
  let json = false;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === undefined) continue;
    if (arg === "-h" || arg === "--help") {
      throw new HelpRequested();
    } else if (arg === "--json") {
      json = true;
    } else if (arg === "--max" || arg === "--verify-limit") {
      const value = argv[++i];
      if (value === undefined || !/^\d+$/.test(value)) {
        throw new Error(`选项 ${arg} 需要一个非负整数参数`);
      }
      if (arg === "--max") max = BigInt(value);
      else verifyLimit = BigInt(value);
    } else if (arg.startsWith("--")) {
      throw new Error(`未知选项: ${arg}`);
    } else {
      positional.push(arg);
    }
  }
  const targetText = positional[0];
  if (targetText === undefined || !/^\d+$/.test(targetText)) {
    throw new Error("缺少目标金额（非负整数）");
  }
  const stepTexts = positional.slice(1);
  if (stepTexts.length === 0) {
    throw new Error("至少需要 1 个折扣步骤");
  }
  if (stepTexts.length > MAX_STEPS) {
    throw new Error(`折扣链最多 ${MAX_STEPS} 步，当前为 ${stepTexts.length} 步`);
  }
  return {
    target: BigInt(targetText),
    steps: stepTexts.map(parseStep),
    max,
    verifyLimit,
    json,
  };
}

function formatInterval([lo, hi]: Interval): string {
  return `[${lo}, ${hi}]`;
}

function formatStep(step: RationalStep): string {
  return step.q === 1n ? `${step.p}` : `${step.p}/${step.q}`;
}

/** 执行 CLI 主逻辑，返回退出码与输出文本（纯函数，便于测试） */
export function runCli(argv: readonly string[]): CliResult {
  let args: CliArgs;
  try {
    args = parseArgs(argv);
  } catch (err) {
    if (err instanceof HelpRequested) {
      return { code: 0, stdout: USAGE, stderr: "" };
    }
    return {
      code: 1,
      stdout: "",
      stderr: `错误: ${(err as Error).message}\n使用 --help 查看用法`,
    };
  }

  const intervals = invertChain(args.steps, args.target, 0n, args.max);
  const count = countValues(intervals);
  const verify =
    args.verifyLimit > 0n
      ? verifyLowDomain(args.steps, args.target, intervals, args.verifyLimit, 0n, args.max)
      : null;

  if (args.json) {
    const out = {
      target: args.target.toString(),
      steps: args.steps.map(formatStep),
      domain: ["0", args.max.toString()],
      intervals: intervals.map(([lo, hi]) => [lo.toString(), hi.toString()]),
      count: count.toString(),
      verify:
        verify === null
          ? null
          : {
              limit: verify.limit.toString(),
              checked: verify.checked.toString(),
              mismatches: verify.mismatches.map(String),
              boundaryErrors: verify.boundaryErrors.map(String),
              truncated: verify.truncated,
              ok: verify.mismatches.length === 0 && verify.boundaryErrors.length === 0,
            },
    };
    return { code: 0, stdout: JSON.stringify(out, null, 2), stderr: "" };
  }

  const lines: string[] = [];
  lines.push(`目标金额: ${args.target}`);
  lines.push(`折扣链: ${args.steps.map(formatStep).join(" -> ")}（每步后最近偶数舍入）`);
  lines.push(`原价定义域: [0, ${args.max}]`);
  if (intervals.length === 0) {
    lines.push("可接受原价区间: 无（该金额无法由此折扣链得到）");
  } else {
    lines.push("可接受原价闭区间（互不交叠）:");
    for (const iv of intervals) lines.push(`  ${formatInterval(iv)}`);
    lines.push(`整数值个数: ${count}`);
  }
  let stderr = "";
  let code = 0;
  if (verify !== null) {
    const ok = verify.mismatches.length === 0 && verify.boundaryErrors.length === 0;
    const truncatedNote = verify.truncated ? "，部分区间超出上限未逐值核验" : "";
    lines.push(
      `低价域逐值前向核验 (<= ${verify.limit}): ${ok ? "通过" : "失败"}，` +
        `共核验 ${verify.checked} 个值及区间边界${truncatedNote}`
    );
    if (!ok) {
      const problems: string[] = [];
      if (verify.mismatches.length > 0) {
        problems.push(`区间内不一致值: ${verify.mismatches.join(", ")}`);
      }
      if (verify.boundaryErrors.length > 0) {
        problems.push(`边界外误命中值: ${verify.boundaryErrors.join(", ")}`);
      }
      stderr = problems.join("\n");
      code = 2;
    }
  }
  return { code, stdout: lines.join("\n"), stderr };
}
