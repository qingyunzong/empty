import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { run } from "../cli.js";

let counter = 0;

export function tmpFile(name = "ledger") {
  const dir = mkdtempSync(join(tmpdir(), "trade-replay-"));
  return join(dir, `${name}-${process.pid}-${counter++}.txb`);
}

export function runCli(args) {
  let stdout = "";
  let stderr = "";
  const code = run(args, { stdout: (s) => (stdout += s), stderr: (s) => (stderr += s) });
  return {
    code,
    stdout,
    stderr,
    json: safeParse(code === 0 ? stdout : stderr),
  };
}

function safeParse(text) {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}
