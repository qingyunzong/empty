import { readFileSync, writeFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { validateProblem } from "./validate.js";
import { bruteForce, solve, type BruteForceResult } from "./solver.js";
import { buildCertificate } from "./certificate.js";

const USAGE = `投放规划 CLI — 整数投放量优化（收益最大，并列成本最低）

用法:
  node dist/src/cli.js <input.json | -> [选项]

选项:
  --brute        额外运行穷举求解器并在证书中交叉验证（组合数过大时自动跳过）
  --pretty       缩进格式化输出
  --out <file>   将证书写入文件（默认输出到标准输出）
  -h, --help     显示帮助

退出码: 0 = 已求得最优解, 1 = 无可行解, 2 = 输入非法/用法错误

输入格式:
{
  "channels": [{ "id": "search", "budget": 100 }],
  "minImpressions": 50,
  "groups": [{
    "id": "g1",
    "channel": "search",
    "unitCost": 3,
    "unitImpressions": 10,
    "revenue": [0, 5, 9, 12, 14, 15, 16, 17, 18, 19, 20]
  }]
}
约束: 至多 16 个广告组；每组投放量为 0..10 的整数；全部数值为整数。`;

export interface CliResult {
  code: number;
  stdout: string;
  stderr: string;
  outFile: string | null;
}

/** 可测试的 CLI 主逻辑：返回退出码与输出文本，不直接读写进程 IO。 */
export function run(argv: string[], readStdin: () => string): CliResult {
  let input: string | null = null;
  let brute = false;
  let pretty = false;
  let outFile: string | null = null;

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i] as string;
    if (arg === "--brute") brute = true;
    else if (arg === "--pretty") pretty = true;
    else if (arg === "--out") {
      i++;
      if (i >= argv.length) return { code: 2, stdout: "", stderr: `error: --out requires a file path\n\n${USAGE}\n`, outFile: null };
      outFile = argv[i] as string;
    } else if (arg === "--help" || arg === "-h") {
      return { code: 0, stdout: `${USAGE}\n`, stderr: "", outFile: null };
    } else if (arg.startsWith("--")) {
      return { code: 2, stdout: "", stderr: `error: unknown option: ${arg}\n\n${USAGE}\n`, outFile: null };
    } else if (input === null) {
      input = arg;
    } else {
      return { code: 2, stdout: "", stderr: `error: unexpected extra argument: ${arg}\n\n${USAGE}\n`, outFile: null };
    }
  }
  if (input === null) {
    return { code: 2, stdout: "", stderr: `error: missing input file\n\n${USAGE}\n`, outFile: null };
  }

  let rawText: string;
  try {
    rawText = input === "-" ? readStdin() : readFileSync(input, "utf8");
  } catch (err) {
    return { code: 2, stdout: "", stderr: `error: cannot read input: ${(err as Error).message}\n`, outFile: null };
  }

  let problem;
  try {
    problem = validateProblem(JSON.parse(rawText));
  } catch (err) {
    return { code: 2, stdout: "", stderr: `error: ${(err as Error).message}\n`, outFile: null };
  }

  const solution = solve(problem);

  let bruteResult: BruteForceResult | null = null;
  let note = "";
  if (brute) {
    try {
      bruteResult = bruteForce(problem);
    } catch (err) {
      note = `note: brute force cross-check skipped (${(err as Error).message})\n`;
    }
  }

  const certificate = buildCertificate(problem, solution, bruteResult);
  const stdout = JSON.stringify(certificate, null, pretty ? 2 : 0) + "\n";
  return { code: solution.feasible ? 0 : 1, stdout, stderr: note, outFile };
}

function main(): void {
  const result = run(process.argv.slice(2), () => readFileSync(process.stdin.fd as unknown as string, "utf8"));
  if (result.stdout) {
    if (result.outFile !== null) writeFileSync(result.outFile, result.stdout);
    else console.log(result.stdout.replace(/\n$/, ""));
  }
  if (result.stderr) console.error(result.stderr.replace(/\n$/, ""));
  process.exitCode = result.code;
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
