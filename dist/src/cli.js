#!/usr/bin/env node
"use strict";
/**
 * linsolve — exact solver for linear inequalities and congruences over
 * signed 64-bit integer domains. See USAGE in src/app.ts.
 *
 * Exit codes: 0 = SAT, 1 = UNSAT, 2 = error (parse/usage/verification).
 */
Object.defineProperty(exports, "__esModule", { value: true });
const node_fs_1 = require("node:fs");
const app_1 = require("./app");
function readStdin() {
    return new Promise((resolve, reject) => {
        let data = "";
        process.stdin.setEncoding("utf8");
        process.stdin.on("data", (chunk) => {
            data += chunk;
        });
        process.stdin.on("end", () => resolve(data));
        process.stdin.on("error", () => reject(new Error("failed to read stdin")));
    });
}
async function main() {
    let input;
    let argv;
    try {
        const { file } = (0, app_1.parseArgs)(process.argv.slice(2));
        argv = process.argv.slice(2);
        input = file !== null ? (0, node_fs_1.readFileSync)(file, "utf8") : await readStdin();
    }
    catch (err) {
        process.stderr.write(`error: ${err instanceof Error ? err.message : String(err)}\n`);
        process.exitCode = 2;
        return;
    }
    const result = (0, app_1.runCli)(argv, input);
    if (result.out)
        process.stdout.write(result.out);
    if (result.err)
        process.stderr.write(result.err);
    process.exitCode = result.code;
}
main().catch((err) => {
    process.stderr.write(`error: ${err instanceof Error ? err.message : String(err)}\n`);
    process.exitCode = 2;
});
