import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const cliPath = join(here, "..", "src", "cli.js");

interface CliResult {
  status: number;
  stdout: string;
  stderr: string;
}

// Captures via temp files instead of pipes: this sandboxed environment does
// not propagate child-process pipe output through spawnSync.
function runCli(args: string[], stdinPath?: string): CliResult {
  const tag = Math.random().toString(36).slice(2);
  const outPath = join(tmpdir(), `tf-out-${tag}.txt`);
  const errPath = join(tmpdir(), `tf-err-${tag}.txt`);
  const codePath = join(tmpdir(), `tf-code-${tag}.txt`);
  const quoted = [cliPath, ...args].map((a) => `"${a}"`).join(" ");
  const stdin = stdinPath !== undefined ? `< "${stdinPath}"` : "< /dev/null";
  const script =
    `"${process.argv[0]}" ${quoted} ${stdin} ` +
    `> "${outPath}" 2> "${errPath}"; echo $? > "${codePath}"`;
  spawnSync("sh", ["-c", script], { encoding: "utf8" });
  const stdout = readFileSync(outPath, "utf8");
  const stderr = readFileSync(errPath, "utf8");
  const status = Number.parseInt(readFileSync(codePath, "utf8").trim(), 10);
  rmSync(outPath, { force: true });
  rmSync(errPath, { force: true });
  rmSync(codePath, { force: true });
  return { status, stdout, stderr };
}

function withTempJson(data: unknown, fn: (path: string) => void): void {
  const path = join(tmpdir(), `teamforge-test-${Math.random().toString(36).slice(2)}.json`);
  writeFileSync(path, JSON.stringify(data));
  try {
    fn(path);
  } finally {
    rmSync(path, { force: true });
  }
}

const sample = {
  people: [
    { id: "ana", skills: ["backend"], cost: 5 },
    { id: "bo", skills: ["backend", "devops"], cost: 9 },
    { id: "cy", skills: ["devops"], cost: 4 },
    { id: "di", skills: ["backend", "frontend"], cost: 7 },
    { id: "eli", skills: ["frontend"], cost: 3 },
  ],
  forbiddenPairs: [["ana", "bo"]],
  minSkills: { backend: 1, devops: 1, frontend: 1 },
};

test("cli prints optimal team, certificate and verification", () => {
  withTempJson(sample, (path) => {
    const result = runCli([path, "--verify"]);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /Optimal team: cost=11, size=2/);
    assert.match(result.stdout, /Members: cy, di/);
    assert.match(result.stdout, /backend: 1 \(min 1\) OK/);
    assert.match(result.stdout, /ana ~ bo: ana=out, bo=out OK/);
    assert.match(result.stdout, /Certificate: ALL CHECKS PASSED/);
    assert.match(result.stdout, /32 teams enumerated, 11 feasible, optimum confirmed/);
  });
});

test("cli --json emits a machine-readable report", () => {
  withTempJson(sample, (path) => {
    const result = runCli([path, "--json", "--verify"]);
    assert.equal(result.status, 0, result.stderr);
    const report = JSON.parse(result.stdout);
    assert.equal(report.feasible, true);
    assert.equal(report.cost, 11);
    assert.deepEqual(report.members, ["cy", "di"]);
    assert.equal(report.certificate.ok, true);
    assert.equal(report.verification.matchesEnumeration, true);
  });
});

test("cli reads the instance from stdin with '-'", () => {
  withTempJson(sample, (path) => {
    const result = runCli(["-"], path);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /cost=11/);
  });
});

test("cli exits 1 when no feasible team exists", () => {
  withTempJson(
    { people: [{ id: "a", skills: ["s1"], cost: 1 }], minSkills: { s2: 1 } },
    (path) => {
      const result = runCli([path]);
      assert.equal(result.status, 1);
      assert.match(result.stdout, /no feasible team/);
    }
  );
});

test("cli exits 2 on invalid input", () => {
  withTempJson({ people: [{ id: "a", cost: -3 }] }, (path) => {
    const result = runCli([path]);
    assert.equal(result.status, 2);
    assert.match(result.stderr, /invalid input/);
  });
});
