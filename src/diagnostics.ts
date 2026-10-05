export interface Range {
  readonly start: number;
  readonly end: number;
}

export interface DiagnosticReport {
  readonly sourceId: string;
  readonly stage: string;
  readonly code: string;
  readonly message: string;
  readonly cause: string;
  readonly range: Range;
}

export interface Evidence {
  readonly sourceId: string;
  readonly stage: string;
}

export interface Diagnostic {
  readonly code: string;
  readonly message: string;
  readonly cause: string;
  readonly range: Range;
  readonly evidence: readonly Evidence[];
}

interface Entry {
  readonly code: string;
  readonly message: string;
  readonly cause: string;
  readonly range: Range;
  readonly evidence: Map<string, Evidence>;
}

function identityKey(code: string, message: string, cause: string, range: Range): string {
  return JSON.stringify([code, message, cause, range.start, range.end]);
}

function evidenceKey(sourceId: string, stage: string): string {
  return `${sourceId}${stage}`;
}

function compareStrings(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function compareEvidence(a: Evidence, b: Evidence): number {
  return compareStrings(a.sourceId, b.sourceId) || compareStrings(a.stage, b.stage);
}

function compareDiagnostics(a: Diagnostic, b: Diagnostic): number {
  return (
    a.range.start - b.range.start ||
    a.range.end - b.range.end ||
    compareStrings(a.code, b.code) ||
    compareStrings(a.cause, b.cause) ||
    compareStrings(a.message, b.message)
  );
}

function validateReport(report: DiagnosticReport): void {
  const { sourceId, stage, range } = report;
  if (sourceId.length === 0) throw new Error("sourceId must be non-empty");
  if (stage.length === 0) throw new Error("stage must be non-empty");
  if (!Number.isInteger(range.start) || !Number.isInteger(range.end)) {
    throw new Error("range bounds must be integers");
  }
  if (range.start < 0 || range.end < range.start) {
    throw new Error(`invalid range [${range.start}, ${range.end})`);
  }
}

export class DiagnosticStore {
  private readonly entries = new Map<string, Entry>();

  report(report: DiagnosticReport): void {
    validateReport(report);
    const key = identityKey(report.code, report.message, report.cause, report.range);
    let entry = this.entries.get(key);
    if (entry === undefined) {
      entry = {
        code: report.code,
        message: report.message,
        cause: report.cause,
        range: { start: report.range.start, end: report.range.end },
        evidence: new Map(),
      };
      this.entries.set(key, entry);
    }
    const eKey = evidenceKey(report.sourceId, report.stage);
    if (!entry.evidence.has(eKey)) {
      entry.evidence.set(eKey, { sourceId: report.sourceId, stage: report.stage });
    }
  }

  withdrawSource(sourceId: string): void {
    for (const [key, entry] of this.entries) {
      for (const [eKey, evidence] of entry.evidence) {
        if (evidence.sourceId === sourceId) entry.evidence.delete(eKey);
      }
      if (entry.evidence.size === 0) this.entries.delete(key);
    }
  }

  diagnostics(): Diagnostic[] {
    const result: Diagnostic[] = [];
    for (const entry of this.entries.values()) {
      const evidence = [...entry.evidence.values()].sort(compareEvidence);
      result.push({
        code: entry.code,
        message: entry.message,
        cause: entry.cause,
        range: { start: entry.range.start, end: entry.range.end },
        evidence,
      });
    }
    result.sort(compareDiagnostics);
    return result;
  }

  get size(): number {
    return this.entries.size;
  }
}
