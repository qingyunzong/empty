/**
 * Audit core: test records are bound to (sourceHash, command, exitCode).
 * A record is only admissible evidence for the artifact whose source hash
 * matches the record's hash. Records from other hashes are never merged
 * into the current judgment ("no stitching" of old passes / new failures).
 */
export interface TestRecord {
    /** Test suite / case identifier. */
    suite: string;
    /** Exact command that was executed. */
    command: string;
    /** Actual process exit code observed. */
    exitCode: number;
    /** Content hash of the source tree at run time. */
    sourceHash: string;
    /** ISO-8601 timestamp of the run. */
    recordedAt: string;
}
export interface RequiredTest {
    suite: string;
    command: string;
}
export interface ConflictEvidence {
    suite: string;
    command: string;
    /** Records for the SAME (hash, suite, command) with differing exit codes. */
    records: TestRecord[];
}
export interface MissingEvidence {
    suite: string;
    command: string;
    reason: "no-record-for-current-hash";
}
export interface StaleEvidence {
    record: TestRecord;
    reason: "hash-mismatch-excluded";
}
export type Verdict = "pass" | "fail" | "incomplete" | "conflict";
export interface EvidenceReport {
    sourceHash: string;
    verdict: Verdict;
    /** Records admissible for this artifact (same hash). */
    applicable: TestRecord[];
    /** Required tests with no admissible record. */
    missing: MissingEvidence[];
    /** Same-hash records that disagree on the exit code. */
    conflicts: ConflictEvidence[];
    /** Failing admissible records (exitCode !== 0). */
    failures: TestRecord[];
    /** Records excluded because they belong to other source hashes. */
    excludedStale: StaleEvidence[];
}
export declare class AuditLog {
    private readonly records;
    add(record: TestRecord): void;
    private validate;
    all(): readonly TestRecord[];
    /** Records admissible for a given artifact hash (and optional command). */
    forArtifact(sourceHash: string, command?: string): TestRecord[];
}
/**
 * Judge the artifact identified by `currentHash` using ONLY records bound
 * to that hash. Everything else is reported as excluded stale evidence.
 *
 * Verdict precedence: conflict > fail > incomplete > pass.
 */
export declare function evaluateArtifact(log: AuditLog, currentHash: string, required: readonly RequiredTest[]): EvidenceReport;
/** Human-readable evidence summary (missing / conflict / stale / failures). */
export declare function formatReport(report: EvidenceReport): string;
