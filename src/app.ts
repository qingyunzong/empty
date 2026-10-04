import { readFileSync } from "node:fs";
import { parseArgs } from "node:util";
import { parseSuppliers, DEFAULT_DEMAND } from "./config";
import { solveByEnumeration } from "./enumerate";
import { solve } from "./solve";

export const USAGE = `采购优化 CLI：整数数量、阶梯全量单价、运费门槛、起订量；目标为总费用（整数分）最小，费用相同则供应商数量最少。

用法:
  node dist/src/cli.js [--demand N] [--suppliers FILE] [--enumerate]

选项:
  --demand N        总需求数量（非负整数，默认 ${DEFAULT_DEMAND}），采购数量之和恰等于该值
  --suppliers FILE  供应商配置 JSON 文件；缺省时从标准输入读取
  --enumerate       使用全枚举求解（仅用于小需求验收，需求较大时请用默认 DP）
  --help            显示本帮助

退出码: 0=已求得最优解, 1=参数或配置错误, 2=无可行方案`;

export interface CliResult {
  code: number;
  stdout: string;
  stderr: string;
}

/**
 * CLI 主逻辑（可测试）：argv 不含 node/脚本名；
 * readStdin 仅在未提供 --suppliers 时调用。
 */
export function run(argv: string[], readStdin: () => string): CliResult {
  let values: Record<string, string | boolean | undefined>;
  try {
    ({ values } = parseArgs({
      args: argv,
      options: {
        demand: { type: "string", default: String(DEFAULT_DEMAND) },
        suppliers: { type: "string" },
        enumerate: { type: "boolean", default: false },
        help: { type: "boolean", default: false },
      },
    }));
  } catch (err) {
    return { code: 1, stdout: "", stderr: `error: ${(err as Error).message}` };
  }
  if (values.help) return { code: 0, stdout: USAGE, stderr: "" };

  const demand = Number(values.demand);
  if (!Number.isInteger(demand) || demand < 0) {
    return {
      code: 1,
      stdout: "",
      stderr: `error: --demand must be a non-negative integer, got ${JSON.stringify(values.demand)}`,
    };
  }

  let rawText: string;
  if (typeof values.suppliers === "string") {
    try {
      rawText = readFileSync(values.suppliers, "utf8");
    } catch (err) {
      return { code: 1, stdout: "", stderr: `error: failed to read suppliers config: ${(err as Error).message}` };
    }
  } else {
    try {
      rawText = readStdin();
    } catch (err) {
      return { code: 1, stdout: "", stderr: `error: failed to read stdin: ${(err as Error).message}` };
    }
  }

  try {
    const suppliers = parseSuppliers(JSON.parse(rawText));
    const solution = values.enumerate
      ? solveByEnumeration(suppliers, demand)
      : solve(suppliers, demand);
    return {
      code: solution.feasible ? 0 : 2,
      stdout: JSON.stringify(solution, null, 2),
      stderr: "",
    };
  } catch (err) {
    return { code: 1, stdout: "", stderr: `error: ${(err as Error).message}` };
  }
}
