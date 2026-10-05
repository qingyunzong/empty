import { EnumResult } from "./enumerate.js";
import { sameSeq } from "./solver.js";
import { Problem, SolveResult } from "./types.js";

function fmtBytes(n: number): string {
  return `${n}B`;
}

/** 生成人类可读的规划报告（含逐步空间证书与枚举对照）。 */
export function formatReport(
  problem: Problem,
  result: SolveResult,
  enumResult: EnumResult | null
): string {
  const lines: string[] = [];
  const limit = problem.spaceLimit;
  lines.push("== 升级规划 ==");
  lines.push(
    `起点=${problem.start}  终点=${problem.target}  空间上限=${fmtBytes(limit)}  包数=${problem.packages.length}`
  );
  if (result.excluded.length > 0) {
    lines.push(
      `空间排除: ${result.excluded.map((e) => `${e.id}(需${fmtBytes(e.need)})`).join(", ")}`
    );
  } else {
    lines.push("空间排除: 无");
  }

  if (!result.ok) {
    lines.push(`结论: 无可行升级方案。${result.reason ?? ""}`.trim());
  } else if (result.sequence.length === 0) {
    lines.push("结论: 起点即终点，无需下载任何差量包。");
  } else {
    lines.push(
      `结论: 总下载量 ${fmtBytes(result.totalBytes)}，共 ${result.sequence.length} 个包`
    );
    lines.push(`选包序列: ${result.sequence.join(" -> ")}`);
    lines.push("");
    lines.push("-- 逐步空间证书（即需即下载，应用后立即删除已消费包） --");
    const header = ["步骤", "包ID", "边", "下载", "下载后占用", "暂存", "应用峰值", "清理后占用", "校验"];
    const rows = result.steps.map((s) => [
      String(s.index),
      s.id,
      `${s.from}->${s.to}`,
      `+${fmtBytes(s.downloadBytes)}`,
      fmtBytes(s.storedAfterDownload),
      `+${fmtBytes(s.tempBytes)}`,
      fmtBytes(s.peakDuringApply),
      fmtBytes(s.storedAfterCleanup),
      s.withinLimit ? `OK(≤${fmtBytes(limit)})` : `超限(>${fmtBytes(limit)})`,
    ]);
    const widths = header.map((h, i) =>
      Math.max(h.length, ...rows.map((r) => (r[i] as string).length))
    );
    const fmtRow = (cols: string[]): string =>
      cols.map((c, i) => c.padEnd(widths[i] as number, " ")).join("  ").trimEnd();
    lines.push(fmtRow(header));
    for (const r of rows) lines.push(fmtRow(r));
    lines.push(
      `全程峰值占用 ${fmtBytes(result.maxPeak)} ${result.maxPeak <= limit ? "<=" : ">"} 上限 ${fmtBytes(limit)}`
    );
  }

  if (enumResult !== null) {
    lines.push("");
    lines.push("-- 小图枚举对照 --");
    if (enumResult.truncated) {
      lines.push(`枚举路径数超过上限，已截断（已考察 ${enumResult.pathsExamined} 条），结论仅供参考。`);
    } else {
      lines.push(`共考察 ${enumResult.pathsExamined} 条简单路径。`);
    }
    if (enumResult.best === null) {
      lines.push(`枚举最优: 无可行路径。${result.ok ? "不一致!" : "与求解器一致。"}`);
    } else {
      lines.push(
        `枚举最优: 总下载量 ${fmtBytes(enumResult.best.cost)}，序列 [${enumResult.best.seq.join(", ")}]`
      );
      const match =
        result.ok &&
        result.totalBytes === enumResult.best.cost &&
        sameSeq(result.sequence, enumResult.best.seq);
      lines.push(match ? "对照结果: MATCH（与求解器一致）" : "对照结果: MISMATCH（不一致，请检查实现）");
    }
  }
  return lines.join("\n");
}
