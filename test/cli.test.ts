import { test } from "node:test";
import { equal, ok } from "node:assert/strict";
import { spawn } from "node:child_process";
import { closeSync, mkdtempSync, openSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import process from "node:process";

const CLI = join(process.cwd(), "dist", "src", "cli.js");

interface Run {
  stdout: string;
  code: number;
}

// The sandbox blocks spawnSync and swallows piped stdio, so the CLI is
// exercised through async spawn with stdout/stderr redirected to files.
function cli(args: string[], cwd: string): Promise<Run> {
  return new Promise((resolve) => {
    const outFd = openSync(join(cwd, "stdout.txt"), "w");
    const errFd = openSync(join(cwd, "stderr.txt"), "w");
    const child = spawn(process.execPath, [CLI, ...args], {
      cwd,
      stdio: ["ignore", outFd, errFd],
    });
    child.on("error", (err) => {
      closeSync(outFd);
      closeSync(errFd);
      resolve({ stdout: err.message, code: 1 });
    });
    child.on("close", (code) => {
      closeSync(outFd);
      closeSync(errFd);
      const stdout = readFileSync(join(cwd, "stdout.txt"), "utf8");
      const stderr = readFileSync(join(cwd, "stderr.txt"), "utf8");
      resolve({ stdout: stdout + stderr, code: code ?? 1 });
    });
  });
}

function workspace(): string {
  return mkdtempSync(join(tmpdir(), "minicore-test-"));
}

test("CLI end-to-end: SAT solve then independent verify", async () => {
  const dir = workspace();
  const solve = await cli(["solve", "c1=a | b", "c2=!a | c", "--state", "s.json"], dir);
  equal(solve.code, 0, solve.stdout);
  ok(solve.stdout.includes("status: SAT"), solve.stdout);
  ok(solve.stdout.includes("a=0 b=1 c=0"), solve.stdout);
  const verify = await cli(["verify", "--state", "s.json"], dir);
  equal(verify.code, 0, verify.stdout);
  ok(verify.stdout.includes("ALL CHECKS PASSED"), verify.stdout);
});

test("CLI end-to-end: UNSAT solve prints minimal core and proof tree", async () => {
  const dir = workspace();
  const solve = await cli(["solve", "c1=a", "c2=a", "c3=!a", "--state", "s.json"], dir);
  equal(solve.code, 0, solve.stdout);
  ok(solve.stdout.includes("minimal unsat core (2): c1, c3"), solve.stdout);
  ok(solve.stdout.includes("CONTRADICTION c1"), solve.stdout);
  ok(solve.stdout.includes("3 smaller subsets independently checked"), solve.stdout);
  const verify = await cli(["verify", "--state", "s.json"], dir);
  ok(verify.stdout.includes("PASS minimality-all-smaller-subsets-sat"), verify.stdout);
  ok(verify.stdout.includes("PASS proof-tree-valid"), verify.stdout);
});

test("CLI end-to-end: assumptions add/remove drive the conflict cache reuse rule", async () => {
  const dir = workspace();
  await cli(["assume", "add", "h1", "x & y", "--state", "s.json"], dir);
  await cli(["assume", "add", "h2", "!x", "--state", "s.json"], dir);
  const unsat = await cli(["solve", "c1=y -> !y", "--state", "s.json"], dir);
  ok(unsat.stdout.includes("status: UNSAT"), unsat.stdout);
  ok(unsat.stdout.includes("c1, h1"), unsat.stdout);

  // Retract h1: the cached conflict {c1, h1} must no longer be reusable.
  await cli(["assume", "remove", "h1", "--state", "s.json"], dir);
  const sat = await cli(["solve", "c1=y -> !y", "--state", "s.json"], dir);
  ok(sat.stdout.includes("status: SAT"), sat.stdout);
  ok(!sat.stdout.includes("cache: conflict"), sat.stdout);

  // Re-add h1: all sources of the old conflict exist again, so it is reused.
  await cli(["assume", "add", "h1", "x & y", "--state", "s.json"], dir);
  const again = await cli(["solve", "c1=y -> !y", "--state", "s.json"], dir);
  ok(again.stdout.includes("status: UNSAT"), again.stdout);
  ok(again.stdout.includes("cache: conflict {c1, h1} reused"), again.stdout);
});

test("CLI end-to-end: pause persists the frontier and resume finishes it", async () => {
  const dir = workspace();
  const paused = await cli(
    ["solve", "c1=a", "c2=a | b", "c3=!a & b", "c4=!b", "--state", "s.json", "--step-limit", "2"],
    dir,
  );
  equal(paused.code, 3, paused.stdout);
  ok(paused.stdout.includes("status: PAUSED"), paused.stdout);
  ok(paused.stdout.includes("frontier persisted"), paused.stdout);

  const done = await cli(["resume", "--state", "s.json"], dir);
  equal(done.code, 0, done.stdout);
  ok(done.stdout.includes("minimal unsat core (2): c1, c3"), done.stdout);

  const verify = await cli(["verify", "--state", "s.json"], dir);
  ok(verify.stdout.includes("ALL CHECKS PASSED"), verify.stdout);
});

test("CLI end-to-end: input beyond the explicit exhaustive limit is rejected", async () => {
  const dir = workspace();
  const args = ["solve"];
  for (let i = 1; i <= 19; i++) args.push(`c${i}=a`);
  args.push("--state", "s.json");
  const result = await cli(args, dir);
  equal(result.code, 1, result.stdout);
  ok(result.stdout.includes("at most 18 named constraints"), result.stdout);
});

test("CLI end-to-end: limits command prints the exhaustive bounds", async () => {
  const dir = workspace();
  const result = await cli(["limits"], dir);
  equal(result.code, 0, result.stdout);
  ok(result.stdout.includes("2^18 = 262144"), result.stdout);
});

test("CLI end-to-end: constraints merge from file and CLI, CLI wins on name clash", async () => {
  const dir = workspace();
  writeFileSync(
    join(dir, "base.json"),
    JSON.stringify({ constraints: { c1: "a", c2: "b" } }),
  );
  const result = await cli(
    ["solve", "c2=!a & !b", "--file", "base.json", "--state", "s.json"],
    dir,
  );
  equal(result.code, 0, result.stdout);
  // merged set: c1=a, c2=!a & !b -> lex-min is a=1? no: c2 forces a=0,b=0,
  // but c1 forces a=1 -> UNSAT with core {c1, c2}.
  ok(result.stdout.includes("status: UNSAT"), result.stdout);
  ok(result.stdout.includes("c1, c2"), result.stdout);
});
