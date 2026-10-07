import type {
  AuditStatus,
  AuditVerdict,
  ConflictEvidence,
  FailureEvidence,
  MissingEvidence,
  TestRecord,
} from "./types";

/**
 * Append-only audit log. A record is only ever evidence for the source hash
 * it was captured against; evaluation never mixes records across hashes.
 */
export class AuditLog {
  private readonly records: TestRecord[] = [];

  record(
    entry: Omit<TestRecord, "recordedAt"> & { recordedAt?: string }
  ): TestRecord {
    const rec: TestRecord = {
      recordedAt: entry.recordedAt ?? new Date().toISOString(),
      sourceHash: entry.sourceHash,
      command: entry.command,
      exitCode: entry.exitCode,
    };
    this.records.push(rec);
    return rec;
  }

  all(): readonly TestRecord[] {
    return this.records;
  }

  /**
   * Judge the artifact identified by `sourceHash` using only records bound
   * to that exact hash. Fail-closed: any conflict or failure yields "fail",
   * any missing command yields "incomplete".
   */
  evaluate(
    sourceHash: string,
    requiredCommands: readonly string[]
  ): AuditVerdict {
    const current = this.records.filter((r) => r.sourceHash === sourceHash);
    const stale = this.records.filter((r) => r.sourceHash !== sourceHash);

    const missing: MissingEvidence[] = [];
    const conflicts: ConflictEvidence[] = [];
    const failures: FailureEvidence[] = [];
    const passed: string[] = [];

    for (const command of requiredCommands) {
      const recs = current.filter((r) => r.command === command);
      if (recs.length === 0) {
        missing.push({ command, reason: "no-record-for-current-hash" });
        continue;
      }
      const passRecords = recs.filter((r) => r.exitCode === 0);
      const failRecords = recs.filter((r) => r.exitCode !== 0);
      if (passRecords.length > 0 && failRecords.length > 0) {
        conflicts.push({ command, passRecords, failRecords });
      } else if (failRecords.length > 0) {
        failures.push({
          command,
          exitCode: failRecords[failRecords.length - 1].exitCode,
          records: failRecords,
        });
      } else {
        passed.push(command);
      }
    }

    const status: AuditStatus =
      conflicts.length > 0 || failures.length > 0
        ? "fail"
        : missing.length > 0
          ? "incomplete"
          : "pass";

    return {
      sourceHash,
      status,
      missing,
      conflicts,
      failures,
      passed,
      staleRecordsIgnored: stale,
    };
  }
}
