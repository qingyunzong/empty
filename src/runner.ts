import { spawnSync } from "node:child_process";
import type { AuditLog } from "./audit";
import type { TestRecord } from "./types";

/**
 * Execute `command` in a shell and record its actual exit code against
 * `sourceHash`. A signal termination is recorded as exit code 1.
 */
export function runAndRecord(
  log: AuditLog,
  sourceHash: string,
  command: string,
  cwd?: string
): TestRecord {
  const result = spawnSync(command, {
    shell: true,
    encoding: "utf8",
    ...(cwd !== undefined ? { cwd } : {}),
  });
  const exitCode = result.status ?? 1;
  return log.record({ sourceHash, command, exitCode });
}
