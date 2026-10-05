import type { Diagnostic, DiagnosticReport, Evidence } from "../src/diagnostics.js";

export class FullSetModel {
  private reports: DiagnosticReport[] = [];

  report(report: DiagnosticReport): void {
    this.reports.push(report);
  }

  withdrawSource(sourceId: string): void {
    this.reports = this.reports.filter((r) => r.sourceId !== sourceId);
  }

  diagnostics(): Diagnostic[] {
    const groups = new Map<
      string,
      { code: string; message: string; cause: string; range: { start: number; end: number }; evidence: Map<string, Evidence> }
    >();
    for (const r of this.reports) {
      const key = JSON.stringify([r.code, r.message, r.cause, r.range.start, r.range.end]);
      let group = groups.get(key);
      if (group === undefined) {
        group = {
          code: r.code,
          message: r.message,
          cause: r.cause,
          range: { start: r.range.start, end: r.range.end },
          evidence: new Map(),
        };
        groups.set(key, group);
      }
      group.evidence.set(`${r.sourceId} ${r.stage}`, { sourceId: r.sourceId, stage: r.stage });
    }
    const result: Diagnostic[] = [...groups.values()].map((g) => ({
      code: g.code,
      message: g.message,
      cause: g.cause,
      range: g.range,
      evidence: [...g.evidence.values()].sort(
        (a, b) => compare(a.sourceId, b.sourceId) || compare(a.stage, b.stage),
      ),
    }));
    result.sort(
      (a, b) =>
        a.range.start - b.range.start ||
        a.range.end - b.range.end ||
        compare(a.code, b.code) ||
        compare(a.cause, b.cause) ||
        compare(a.message, b.message),
    );
    return result;
  }
}

function compare(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}
