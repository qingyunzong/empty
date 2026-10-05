/**
 * 诊断合并库。
 *
 * 合并规则：
 * - 诊断身份 = (range.start, range.end, reason)。三者完全一致才合并；
 *   范围相邻或重叠但 reason 不同的诊断绝不合并。
 * - 同一诊断可携带多份证据 (Evidence)，按 (sourceId, phase, message) 去重：
 *   同一来源重复上报同一错误只保留一份；不同阶段的引用各自保留。
 * - withdraw(sourceId) 只移除该来源的证据；诊断仍有其他来源证据时保留，
 *   证据清空后诊断才移除。
 * - list() 输出稳定排序：诊断按 (start, end, reason)，
 *   证据按 (sourceId, phase, message)，与插入顺序无关。
 */

export interface Range {
  start: number;
  end: number;
}

export interface Evidence {
  sourceId: string;
  phase: string;
  message: string;
}

export interface Diagnostic {
  range: Range;
  reason: string;
  evidences: Evidence[];
}

export interface Report {
  sourceId: string;
  phase: string;
  range: Range;
  reason: string;
  message: string;
}

function diagnosticKey(range: Range, reason: string): string {
  return `${range.start}:${range.end}:${reason}`;
}

function evidenceKey(ev: Evidence): string {
  return `${ev.sourceId}:${ev.phase}:${ev.message}`;
}

function compareDiagnostics(a: Diagnostic, b: Diagnostic): number {
  return (
    a.range.start - b.range.start ||
    a.range.end - b.range.end ||
    (a.reason < b.reason ? -1 : a.reason > b.reason ? 1 : 0)
  );
}

function compareEvidences(a: Evidence, b: Evidence): number {
  return (
    compareStrings(a.sourceId, b.sourceId) ||
    compareStrings(a.phase, b.phase) ||
    compareStrings(a.message, b.message)
  );
}

function compareStrings(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

interface MutableDiagnostic {
  range: Range;
  reason: string;
  evidences: Map<string, Evidence>;
}

export class DiagnosticStore {
  private diagnostics = new Map<string, MutableDiagnostic>();

  report(report: Report): void {
    const key = diagnosticKey(report.range, report.reason);
    let diag = this.diagnostics.get(key);
    if (diag === undefined) {
      diag = {
        range: { start: report.range.start, end: report.range.end },
        reason: report.reason,
        evidences: new Map<string, Evidence>(),
      };
      this.diagnostics.set(key, diag);
    }
    const evidence: Evidence = {
      sourceId: report.sourceId,
      phase: report.phase,
      message: report.message,
    };
    diag.evidences.set(evidenceKey(evidence), evidence);
  }

  withdraw(sourceId: string): void {
    for (const [key, diag] of this.diagnostics) {
      for (const [evKey, ev] of diag.evidences) {
        if (ev.sourceId === sourceId) {
          diag.evidences.delete(evKey);
        }
      }
      if (diag.evidences.size === 0) {
        this.diagnostics.delete(key);
      }
    }
  }

  list(): Diagnostic[] {
    const result: Diagnostic[] = [];
    for (const diag of this.diagnostics.values()) {
      const evidences = [...diag.evidences.values()].sort(compareEvidences);
      result.push({
        range: { ...diag.range },
        reason: diag.reason,
        evidences,
      });
    }
    result.sort(compareDiagnostics);
    return result;
  }
}
