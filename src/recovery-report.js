import fs from 'node:fs';

// Emits a TAP comment line into the output stream of `node --test` so that
// `node --test 2>&1 | tee test-result.txt` records real recovery hashes.
// Test files run as child processes whose own stdout is rolled up and hidden
// by the runner, so we write directly to the parent process's stdout via
// /proc/<ppid>/fd/1. Falls back to console.log when that is unavailable
// (e.g. non-Linux or running the test file directly).
export function recordRecoveryHash(label, hash) {
  const line = `# RECOVERY_HASH ${label} ${hash}\n`;
  try {
    fs.appendFileSync(`/proc/${process.ppid}/fd/1`, line);
  } catch {
    console.log(line.trimEnd());
  }
}
