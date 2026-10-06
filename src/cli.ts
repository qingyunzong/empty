import { readFileSync } from "node:fs";
import { InputError, loadProblem, MAX_PACKAGES, type Problem } from "./model.js";
import { planIds, planUpgrade, type Plan } from "./planner.js";
import { enumerateBest, type EnumerationResult } from "./enumerate.js";
import { buildCertificate, type Certificate } from "./schedule.js";

const USAGE = `差量包升级路径规划 CLI

用法:
  upgradepath plan <输入.json | -> [--enumerate] [--json]
  upgradepath --help

输入 JSON（差量包至多 ${MAX_PACKAGES} 个）:
  {
    "source": "起始版本",
    "target": "目标版本",
    "spaceLimitBytes": 600,
    "packages": [
      { "id": "pkg-a", "from": "v1", "to": "v2", "bytes": 300 }
    ]
  }

模型:
  每个差量包是有向版本边 from -> to，下载代价为 bytes。
  途中采用即时调度：下载 -> 应用(消费) -> 删除已消费包，
  因此路径的最小峰值暂存 = 路径上最大包字节数；
  超过 spaceLimitBytes 的包永远无法暂存，直接排除。

退出码:
  0 成功；2 输入/用法错误；3 空间限制下无可行方案；4 枚举被截断。
`;

export interface CliIO {
  stdout(text: string): void;
  stderr(text: string): void;
  readStdin(): string;
}

interface CliOptions {
  inputPath: string;
  enumerate: boolean;
  json: boolean;
}

class HelpRequested extends Error {}

function parseArgs(argv: string[]): CliOptions {
  const args = [...argv];
  if (args.length === 0 || args.includes("--help") || args.includes("-h")) {
    throw new HelpRequested();
  }
  const command = args.shift();
  if (command !== "plan") {
    throw new InputError(`未知命令 "${command ?? ""}"\n${USAGE}`);
  }
  let inputPath: string | null = null;
  let enumerate = false;
  let json = false;
  for (const arg of args) {
    if (arg === "--enumerate") enumerate = true;
    else if (arg === "--json") json = true;
    else if (arg.startsWith("--")) throw new InputError(`未知选项 "${arg}"`);
    else if (inputPath === null) inputPath = arg;
    else throw new InputError(`多余参数 "${arg}"`);
  }
  if (inputPath === null) {
    throw new InputError(`缺少输入文件路径（或 - 表示标准输入）\n${USAGE}`);
  }
  return { inputPath, enumerate, json };
}

function readInput(path: string, io: CliIO): string {
  try {
    if (path === "-") {
      return io.readStdin();
    }
    return readFileSync(path, "utf8");
  } catch (error) {
    throw new InputError(`读取输入失败: ${(error as Error).message}`);
  }
}

function pad(value: string, width: number): string {
  return value.length >= width ? value : value + " ".repeat(width - value.length);
}

function renderCertificateTable(cert: Certificate): string {
  const header = ["step", "action", "package", "version", "stored(B)", "peak(B)", "note"];
  const rows = cert.steps.map((s) => [
    String(s.index),
    s.action,
    s.packageId,
    s.versionAfter,
    String(s.storedBytes),
    String(s.peakBytes),
    s.note,
  ]);
  const widths = header.map((h, i) => Math.max(h.length, ...rows.map((r) => r[i].length)));
  const line = (cols: string[]): string => cols.map((c, i) => pad(c, widths[i])).join("  ").trimEnd();
  const out = [line(header), line(widths.map((w) => "-".repeat(w)))];
  for (const row of rows) out.push(line(row));
  return out.join("\n");
}

function renderText(
  problem: Problem,
  plan: Plan,
  cert: Certificate,
  enumeration: EnumerationResult | null,
): string {
  const ids = planIds(plan);
  const lines: string[] = [];
  lines.push(`升级规划: ${problem.source} -> ${problem.target}`);
  lines.push(
    `总下载量: ${plan.totalBytes} B    峰值暂存: ${cert.peakBytes} B    上限: ${problem.spaceLimitBytes} B    包数: ${ids.length}`,
  );
  lines.push(`包 ID 序列: ${ids.length === 0 ? "(空，已在目标版本)" : ids.join(", ")}`);
  lines.push("");
  lines.push("逐步空间证书:");
  lines.push(renderCertificateTable(cert));
  lines.push("");
  if (cert.ok) {
    lines.push(
      `空间证书: OK — 峰值 ${cert.peakBytes} B <= 上限 ${cert.limitBytes} B；结束暂存 0 B；到达目标版本 ${cert.finalVersion}`,
    );
  } else {
    lines.push("空间证书: 失败");
    for (const p of cert.problems) lines.push(`  - ${p}`);
  }
  if (enumeration !== null) {
    lines.push("");
    if (enumeration.truncated) {
      lines.push(`枚举对照: 截断（已探索 ${enumeration.exploredStates} 个状态，图过大）`);
    } else if (enumeration.best === null) {
      lines.push("枚举对照: 枚举无可行路径，与规划器结果不一致（规划器有解）");
    } else {
      const enumIds = planIds(enumeration.best);
      const consistent =
        enumeration.best.totalBytes === plan.totalBytes &&
        enumIds.length === ids.length &&
        enumIds.every((id, i) => id === ids[i]);
      lines.push(
        `枚举对照: ${consistent ? "一致" : "不一致"}（枚举 ${enumeration.pathCount} 条简单路径，最优 ${enumeration.best.totalBytes} B / ${enumIds.join(", ")}）`,
      );
    }
  }
  return lines.join("\n") + "\n";
}

function renderJson(plan: Plan, cert: Certificate, enumeration: EnumerationResult | null): string {
  const payload = {
    plan: {
      packageIds: planIds(plan),
      totalBytes: plan.totalBytes,
      peakBytes: cert.peakBytes,
      limitBytes: cert.limitBytes,
    },
    certificate: cert,
    enumeration: enumeration === null
      ? undefined
      : {
          pathCount: enumeration.pathCount,
          exploredStates: enumeration.exploredStates,
          truncated: enumeration.truncated,
          best: enumeration.best === null
            ? null
            : { packageIds: planIds(enumeration.best), totalBytes: enumeration.best.totalBytes },
        },
  };
  return JSON.stringify(payload, null, 2) + "\n";
}

export function run(argv: string[], io: CliIO): number {
  let options: CliOptions;
  try {
    options = parseArgs(argv);
  } catch (error) {
    if (error instanceof HelpRequested) {
      io.stdout(USAGE);
      return 0;
    }
    if (error instanceof InputError) {
      io.stderr(`错误: ${error.message}\n`);
      return 2;
    }
    throw error;
  }
  let problem: Problem;
  try {
    problem = loadProblem(readInput(options.inputPath, io));
  } catch (error) {
    if (error instanceof InputError) {
      io.stderr(`错误: ${error.message}\n`);
      return 2;
    }
    throw error;
  }
  const plan = planUpgrade(problem);
  if (plan === null) {
    const skipped = problem.packages.length - problem.packages.filter(
      (p) => p.bytes <= problem.spaceLimitBytes,
    ).length;
    io.stderr(
      `无可行方案: 在空间上限 ${problem.spaceLimitBytes} B 下无法从 ${problem.source} 到达 ${problem.target}` +
        (skipped > 0 ? `（${skipped} 个包因超过上限被排除）` : "") + "\n",
    );
    return 3;
  }
  const cert = buildCertificate(problem, plan);
  const enumeration = options.enumerate ? enumerateBest(problem) : null;
  io.stdout(options.json ? renderJson(plan, cert, enumeration) : renderText(problem, plan, cert, enumeration));
  if (!cert.ok) return 3;
  if (enumeration !== null && enumeration.truncated) return 4;
  return 0;
}
