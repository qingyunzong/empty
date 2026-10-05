import { readFileSync } from "node:fs";
import { enumerateBest, DEFAULT_ENUM_CAP, EnumResult } from "./enumerate.js";
import { parseProblem } from "./parse.js";
import { formatReport } from "./report.js";
import { sameSeq, solve } from "./solver.js";

export const USAGE = `用法: upgrade-plan <input.json | -> [选项]

差量包升级路径规划：在空间限制下选总下载量最小的有向路径，
并列时取包 ID 序列字典序最小者，并输出逐步空间证书与小图枚举对照。

输入 JSON:
{
  "start": "v1",              // 起始版本
  "target": "v4",             // 目标版本
  "spaceLimit": 300,          // 磁盘空间上限（字节）
  "packages": [               // 至多 18 个差量包（有向版本边）
    { "id": "p1", "from": "v1", "to": "v2", "bytes": 100, "peak": 120 }
  ]
}

选项:
  --enumerate / --no-enumerate   强制开/关枚举对照（默认开）
  --cap <N>                      枚举路径数上限（默认 ${DEFAULT_ENUM_CAP}）
  --json                         以 JSON 输出结果
  -h, --help                     显示帮助

退出码: 0=成功  1=输入/用法错误  2=无可行方案  3=枚举对照不一致`;

export interface CliOutput {
  code: number;
  out: string;
  err: string;
}

interface CliArgs {
  input: string;
  enumerate: boolean;
  cap: number;
  json: boolean;
}

class UsageError extends Error {}
class ShowHelp extends Error {}

function parseArgs(argv: string[]): CliArgs {
  let input: string | null = null;
  let enumerate = true;
  let cap = DEFAULT_ENUM_CAP;
  let json = false;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i] as string;
    if (arg === "-h" || arg === "--help") {
      throw new ShowHelp();
    } else if (arg === "--enumerate") {
      enumerate = true;
    } else if (arg === "--no-enumerate") {
      enumerate = false;
    } else if (arg === "--json") {
      json = true;
    } else if (arg === "--cap") {
      const v = argv[++i];
      if (v === undefined || !/^\d+$/.test(v)) throw new UsageError("--cap 需要非负整数参数");
      cap = Number(v);
    } else if (arg.startsWith("-") && arg !== "-") {
      throw new UsageError(`未知选项: ${arg}`);
    } else if (input === null) {
      input = arg;
    } else {
      throw new UsageError(`多余的位置参数: ${arg}`);
    }
  }
  if (input === null) throw new UsageError("缺少输入文件（或用 - 从标准输入读取）");
  return { input, enumerate, cap, json };
}

/**
 * CLI 主逻辑（可进程内测试）。
 * @param argv 不含 node 与脚本名的参数列表
 * @param readStdin 当输入为 "-" 时读取标准输入的回调
 */
export function runCli(argv: string[], readStdin: () => string): CliOutput {
  let args: CliArgs;
  try {
    args = parseArgs(argv);
  } catch (e) {
    if (e instanceof ShowHelp) return { code: 0, out: USAGE + "\n", err: "" };
    const msg = e instanceof UsageError ? (e as Error).message : String(e);
    return { code: 1, out: "", err: `错误: ${msg}\n\n${USAGE}\n` };
  }

  let rawText: string;
  try {
    rawText = args.input === "-" ? readStdin() : readFileSync(args.input, "utf8");
  } catch {
    return { code: 1, out: "", err: `错误: 无法读取输入 ${args.input}\n` };
  }

  let rawJson: unknown;
  try {
    rawJson = JSON.parse(rawText);
  } catch (e) {
    return { code: 1, out: "", err: `错误: JSON 解析失败: ${(e as Error).message}\n` };
  }

  let problem;
  try {
    problem = parseProblem(rawJson);
  } catch (e) {
    return { code: 1, out: "", err: `${(e as Error).message}\n` };
  }

  const result = solve(problem);
  const enumResult: EnumResult | null = args.enumerate
    ? enumerateBest(problem, args.cap)
    : null;

  const out = args.json
    ? JSON.stringify({ problem, result, enumeration: enumResult }, null, 2) + "\n"
    : formatReport(problem, result, enumResult) + "\n";

  let code = 0;
  if (!result.ok) {
    code = 2;
  } else if (
    enumResult !== null &&
    !enumResult.truncated &&
    (enumResult.best === null ||
      enumResult.best.cost !== result.totalBytes ||
      !sameSeq(enumResult.best.seq, result.sequence))
  ) {
    code = 3;
  }
  return { code, out, err: "" };
}
