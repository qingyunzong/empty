import { test } from "node:test";
import { equal, ok } from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Board } from "../src/board.ts";
import { verifyCertificate, type Certificate } from "../src/certificate.ts";
import { runCli } from "../src/cli.ts";
import type { BoardSpec } from "../src/types.ts";

const root = fileURLToPath(new URL("../..", import.meta.url));

function run(args: string[]): { status: number; stdout: string; stderr: string } {
  const out: string[] = [];
  const err: string[] = [];
  const status = runCli(args, {
    log: (m) => out.push(m),
    error: (m) => err.push(m),
  });
  return { status, stdout: out.join("\n"), stderr: err.join("\n") };
}

test("CLI solves the line example and prints step-by-step boards", () => {
  const run1 = run([join(root, "examples", "line.json")]);
  equal(run1.status, 0, run1.stderr);
  ok(run1.stdout.includes("optimal captures: 2"));
  ok(run1.stdout.includes("landing sequence: (0,1) -> (2,1)"));
  ok(run1.stdout.includes("[capture 1]"));
  ok(run1.stdout.includes("certificate:"));
});

test("CLI --json emits a verifiable certificate for every example", () => {
  for (const [name, expected] of [["line", 2], ["toggle", 1], ["push", 1]] as const) {
    const puzzlePath = join(root, "examples", `${name}.json`);
    const res = run([puzzlePath, "--json"]);
    equal(res.status, 0, res.stderr);
    const cert = JSON.parse(res.stdout) as Certificate;
    equal(cert.optimal, expected, name);
    ok(cert.proved, name);
    ok(cert.optimal <= cert.safetyUpperBound, name);
    const spec = JSON.parse(readFileSync(puzzlePath, "utf8")) as BoardSpec;
    const check = verifyCertificate(new Board(spec), cert);
    ok(check.ok, `${name}: ${check.problems.join("; ")}`);
  }
});

test("CLI rejects invalid puzzles", () => {
  const dir = mkdtempSync(join(tmpdir(), "jumpforge-bad-"));
  const bad = join(dir, "bad.json");
  writeFileSync(bad, JSON.stringify({ width: 2, height: 2, player: [0, 0], enemies: [], directionsA: [] }));
  const res = run([bad]);
  ok(res.status !== 0);
});
