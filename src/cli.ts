import { readFileSync } from "node:fs";
import { Problem } from "./model";
import { solveDp, solveEnumerate, SolveResult } from "./solve";

export interface CliOutput {
  code: number;
  stdout: string;
  stderr: string;
}

function render(result: SolveResult, p: Problem) {
  return {
    feasible: result.feasible,
    quantities: result.best
      ? Object.fromEntries(p.suppliers.map((s, i) => [s.id, result.best?.qty[i] ?? 0]))
      : null,
    vector: result.best?.qty ?? null,
    totalQty: result.best?.totalQty ?? null,
    overPurchase: result.best ? result.best.totalQty - p.demand : null,
    totalCost: result.best?.totalCost ?? null,
    slots: result.slots,
  };
}

/** 可测试的 CLI 主体：argv 为 process.argv.slice(2)，stdin 为输入 JSON（无文件参数时使用） */
export function runCli(argv: string[], stdin?: string): CliOutput {
  const verify = argv.includes("--verify");
  const files = argv.filter((a) => a !== "--verify");
  let raw: string;
  if (files.length > 0 && files[0] !== "-") {
    raw = readFileSync(files[0] as string, "utf8");
  } else if (stdin !== undefined) {
    raw = stdin;
  } else {
    raw = readFileSync(0, "utf8");
  }
  const problem = JSON.parse(raw) as Problem;
  const dp = solveDp(problem);
  const out: Record<string, unknown> = { solver: "dp", ...render(dp, problem) };
  let code = 0;
  let stderr = "";
  if (verify) {
    const en = solveEnumerate(problem);
    const match =
      dp.feasible === en.feasible && JSON.stringify(dp.best) === JSON.stringify(en.best);
    out.verification = { method: "enumerate", match, enumerate: render(en, problem) };
    if (!match) {
      stderr = "DP 与枚举结果不一致\n";
      code = 2;
    }
  }
  if (!dp.feasible && code === 0) code = 1;
  return { code, stdout: JSON.stringify(out, null, 2) + "\n", stderr };
}

if (require.main === module) {
  const { code, stdout, stderr } = runCli(process.argv.slice(2));
  if (stderr) process.stderr.write(stderr);
  process.stdout.write(stdout);
  process.exitCode = code;
}
