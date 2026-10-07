import { spawnSync } from "node:child_process";
import { AuditLog, TestRecord } from "./audit";
import { hashSourceTree } from "./hash";

/**
 * Hash the current source tree, execute `command`, and record the ACTUAL
 * exit code bound to that hash. The record is admissible only for the
 * artifact built from this exact source content.
 */
export function runAndRecord(
  log: AuditLog,
  dir: string,
  suite: string,
  command: string,
): TestRecord {
  const sourceHash = hashSourceTree(dir);
  const res = spawnSync(command, { cwd: dir, shell: true, stdio: "pipe" });
  if (res.error) throw res.error;
  const exitCode = res.status === null ? 1 : res.status;
  const record: TestRecord = {
    suite,
    command,
    exitCode,
    sourceHash,
    recordedAt: new Date().toISOString(),
  };
  log.add(record);
  return record;
}
