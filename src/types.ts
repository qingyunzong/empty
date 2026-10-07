/** A single audited test execution, bound to the exact source it ran against. */
export interface TestRecord {
  /** SHA-256 of the source file set the test ran against. */
  readonly sourceHash: string;
  /** The command that was executed. */
  readonly command: string;
  /** The actual process exit code (0 = pass). */
  readonly exitCode: number;
  /** ISO-8601 timestamp of when the record was created. */
  readonly recordedAt: string;
}

export interface MissingEvidence {
  readonly command: string;
  readonly reason: "no-record-for-current-hash";
}

/** Same hash + same command produced both passing and failing exit codes. */
export interface ConflictEvidence {
  readonly command: string;
  readonly passRecords: readonly TestRecord[];
  readonly failRecords: readonly TestRecord[];
}

/** Every record for this hash + command is a failure. */
export interface FailureEvidence {
  readonly command: string;
  readonly exitCode: number;
  readonly records: readonly TestRecord[];
}

export type AuditStatus = "pass" | "fail" | "incomplete";

export interface AuditVerdict {
  readonly sourceHash: string;
  readonly status: AuditStatus;
  /** Required commands with no record bound to the current hash. */
  readonly missing: readonly MissingEvidence[];
  /** Commands whose same-hash records disagree on the outcome. */
  readonly conflicts: readonly ConflictEvidence[];
  /** Commands whose same-hash records all failed. */
  readonly failures: readonly FailureEvidence[];
  /** Commands proven green for the current hash. */
  readonly passed: readonly string[];
  /**
   * Records bound to other source hashes. They were excluded from the
   * verdict: stale passes are never spliced into the current artifact.
   */
  readonly staleRecordsIgnored: readonly TestRecord[];
}
