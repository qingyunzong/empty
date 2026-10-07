"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.runAndRecord = runAndRecord;
const node_child_process_1 = require("node:child_process");
const hash_1 = require("./hash");
/**
 * Hash the current source tree, execute `command`, and record the ACTUAL
 * exit code bound to that hash. The record is admissible only for the
 * artifact built from this exact source content.
 */
function runAndRecord(log, dir, suite, command) {
    const sourceHash = (0, hash_1.hashSourceTree)(dir);
    const res = (0, node_child_process_1.spawnSync)(command, { cwd: dir, shell: true, stdio: "pipe" });
    if (res.error)
        throw res.error;
    const exitCode = res.status === null ? 1 : res.status;
    const record = {
        suite,
        command,
        exitCode,
        sourceHash,
        recordedAt: new Date().toISOString(),
    };
    log.add(record);
    return record;
}
