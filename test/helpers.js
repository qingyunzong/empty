import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { run } from "../src/cli.js";

export function tmpDir() {
  return mkdtempSync(join(tmpdir(), "plc-test-"));
}

export function cleanup(dir) {
  rmSync(dir, { recursive: true, force: true });
}

// Runs the CLI in-process (the sandbox forbids spawning child processes).
// env may set PLC_FAULT to arm a fault-injection point for this invocation.
export function cli(dir, args, env = {}) {
  let stdout = "";
  let stderr = "";
  let code = 0;
  const saved = {};
  for (const [k, v] of Object.entries(env)) {
    saved[k] = process.env[k];
    process.env[k] = v;
  }
  try {
    run(["--dir", dir, ...args], {
      out: (s) => { stdout += s; },
      err: (s) => { stderr += s; },
      exit: (c) => { code = c; },
    });
  } finally {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
  return { code, stdout: stdout.trim(), stderr: stderr.trim() };
}

export function cliJson(dir, args, env = {}) {
  const r = cli(dir, args, env);
  return { ...r, json: r.stdout ? JSON.parse(r.stdout) : null };
}

// Deterministic PRNG (mulberry32).
export function mulberry32(seed) {
  let a = seed | 0;
  return function () {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
