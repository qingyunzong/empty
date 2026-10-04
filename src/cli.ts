import { readFileSync, writeFileSync } from "node:fs";
import { parseArgs } from "node:util";
import {
  formatReport,
  syncImport,
  type FieldResolution,
  type MergeMode,
  type Snapshot,
} from "./index.js";

const USAGE = `用法: node dist/src/cli.js --base <基线.json> --source <源快照.json> --target <目标.json> [选项]

选项:
  --base <文件>         目标基线快照（上次同步时的目标状态），必填
  --source <文件>       待导入的源快照，必填
  --target <文件>       目标当前状态，必填
  --resolutions <文件>  字段级显式决议 JSON 数组，可选
  --mode <strict|auto>  合并模式，默认 strict
  --out <文件>          批次应用成功时写出合并结果，缺省打印到 stdout
  --help                显示帮助

退出码: 0=批次已应用；1=存在未解冲突（全批未应用）；2=参数或输入错误`;

export interface CliResult {
  code: number;
  output: string;
}

function readJson(path: string): unknown {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch (err) {
    throw new Error(`无法读取 JSON 文件 ${path}: ${(err as Error).message}`);
  }
}

export function runCli(argv: string[]): CliResult {
  const lines: string[] = [];
  const done = (code: number): CliResult => ({ code, output: lines.join("\n") });

  let values: Record<string, string | boolean | undefined>;
  try {
    ({ values } = parseArgs({
      args: argv,
      options: {
        base: { type: "string" },
        source: { type: "string" },
        target: { type: "string" },
        resolutions: { type: "string" },
        mode: { type: "string", default: "strict" },
        out: { type: "string" },
        help: { type: "boolean", default: false },
      },
    }));
  } catch (err) {
    lines.push(`参数错误: ${(err as Error).message}`);
    lines.push(USAGE);
    return done(2);
  }

  if (values.help === true) {
    lines.push(USAGE);
    return done(0);
  }
  const basePath = values.base;
  const sourcePath = values.source;
  const targetPath = values.target;
  if (
    typeof basePath !== "string" ||
    typeof sourcePath !== "string" ||
    typeof targetPath !== "string"
  ) {
    lines.push(USAGE);
    return done(2);
  }
  const mode = values.mode as MergeMode;
  if (mode !== "strict" && mode !== "auto") {
    lines.push(`--mode 必须是 strict 或 auto，收到: ${String(values.mode)}`);
    return done(2);
  }

  try {
    const base = readJson(basePath) as Snapshot;
    const source = readJson(sourcePath) as Snapshot;
    const target = readJson(targetPath) as Snapshot;
    const resolutionsPath = values.resolutions;
    const resolutions =
      typeof resolutionsPath === "string"
        ? (readJson(resolutionsPath) as FieldResolution[])
        : undefined;

    const report = syncImport(base, source, target, { mode, resolutions });
    lines.push(formatReport(report));

    if (report.applied && report.result !== undefined) {
      const outPath = values.out;
      if (typeof outPath === "string") {
        writeFileSync(outPath, JSON.stringify(report.result, null, 2) + "\n");
        lines.push(`合并结果已写入: ${outPath}`);
      } else {
        lines.push("合并结果:");
        lines.push(JSON.stringify(report.result, null, 2));
      }
      return done(0);
    }
    return done(1);
  } catch (err) {
    lines.push(`错误: ${(err as Error).message}`);
    return done(2);
  }
}

if (require.main === module) {
  const { code, output } = runCli(process.argv.slice(2));
  if (output.length > 0) console.log(output);
  process.exitCode = code;
}
