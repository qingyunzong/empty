// 核验报告格式化（纯文本，中文标签）
import {
  FIELD_LABELS,
  SOURCE_LABELS,
  STATUS_LABELS,
  type Citation,
  type Evidence,
  type VerifyReport,
} from './verify.js';

function formatCitation(c: Citation): string {
  const { start, end } = c.range;
  return `${c.file}#${c.pointer} (行 ${start.line}:${start.col}-${end.line}:${end.col})`;
}

function truncate(value: string, max = 60): string {
  return value.length > max ? `${value.slice(0, max)}…` : value;
}

function formatEvidence(e: Evidence): string {
  return `    ${SOURCE_LABELS[e.source]} ${formatCitation(e.citation)} 取值 "${truncate(e.value)}"`;
}

export function formatReport(report: VerifyReport): string {
  const lines: string[] = [];
  lines.push('=== 核验报告 ===');
  for (const check of report.checks) {
    lines.push(
      `[${STATUS_LABELS[check.status]}] ${check.itemId} / ${check.runId} · ${FIELD_LABELS[check.field]}`,
    );
    if (check.status === 'unknown') {
      for (const m of check.missing) {
        lines.push(`    缺失证据: ${SOURCE_LABELS[m.source]} (${m.file}) — ${m.reason}`);
      }
    }
    if (check.status === 'conflict') {
      lines.push(`    最小冲突对 (${check.conflictPairs.length} 对):`);
      check.conflictPairs.forEach((pair, idx) => {
        lines.push(`    冲突对 ${idx + 1}:`);
        lines.push(formatEvidence(pair.a));
        lines.push(formatEvidence(pair.b));
      });
    }
  }
  for (const orphan of report.orphans) {
    lines.push(`[未知] 孤儿运行 ${orphan.runId} · 来源 ${SOURCE_LABELS[orphan.source]}`);
    lines.push(`    ${orphan.reason}: ${formatCitation(orphan.citation)}`);
  }
  const s = report.summary;
  lines.push(
    `--- 汇总: 检查 ${s.total} 项, 一致 ${s.consistent}, 未知 ${s.unknown}, 冲突 ${s.conflict}, 孤儿运行 ${s.orphans} ---`,
  );
  return lines.join('\n');
}
