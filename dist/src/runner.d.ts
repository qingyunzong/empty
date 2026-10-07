import { AuditLog, TestRecord } from "./audit";
/**
 * Hash the current source tree, execute `command`, and record the ACTUAL
 * exit code bound to that hash. The record is admissible only for the
 * artifact built from this exact source content.
 */
export declare function runAndRecord(log: AuditLog, dir: string, suite: string, command: string): TestRecord;
