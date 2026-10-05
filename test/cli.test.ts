import { test } from "node:test";
import * as assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync, openSync, closeSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const CLI = join(__dirname, "..", "src", "cli.js");

// This sandbox blocks vfork (so execFileSync fails with EPERM) and drops
// data on child stdout pipes, so the CLI is spawned asynchronously with its
// output redirected to a temp file instead.
function runCli(args: string[], spec?: unknown): Promise<{ code: number; stdout: string }> {
  const dir = mkdtempSync(join(tmpdir(), "transfer-cli-"));
  const allArgs = [...args];
  if (spec !== undefined) {
    const specFile = join(dir, "net.json");
    writeFileSync(specFile, JSON.stringify(spec));
    allArgs.push("--input", specFile);
  }
  const outFile = join(dir, "out.txt");
  const fd = openSync(outFile, "w");
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [CLI, ...allArgs], { stdio: ["ignore", fd, fd] });
    child.on("error", reject);
    child.on("close", (code) => {
      closeSync(fd);
      resolve({ code: code ?? -1, stdout: readFileSync(outFile, "utf8") });
    });
  });
}

const SPEC = {
  source: "alice",
  sink: "carol",
  amount: 4,
  edges: [
    {
      from: "alice",
      to: "bob",
      capacity: 3,
      segments: [
        { upTo: 2, unitCost: 1 },
        { upTo: 3, unitCost: 4 },
      ],
    },
    { from: "bob", to: "carol", capacity: 3, segments: [{ upTo: 3, unitCost: 1 }] },
    { from: "alice", to: "carol", capacity: 2, segments: [{ upTo: 2, unitCost: 5 }] },
  ],
};

test("CLI solves a network from a file and prints the certificate", async () => {
  const { code, stdout } = await runCli([], SPEC);
  assert.equal(code, 0);
  const out = JSON.parse(stdout);
  assert.equal(out.status, "optimal");
  assert.equal(out.sent, 4);
  // 3 via alice->bob->carol: (1+1+4) + (1+1+1) = 9, plus 1 direct at 5 => 14
  assert.equal(out.totalCost, 14);
  assert.equal(out.certificate.valid, true);
  assert.equal(typeof out.potentials.alice, "number");
});

test("CLI --enumerate agrees with the solver", async () => {
  const { code, stdout } = await runCli(["--enumerate"], SPEC);
  assert.equal(code, 0);
  const out = JSON.parse(stdout);
  assert.equal(out.enumeration.checked, true);
  assert.equal(out.enumeration.matches, true);
});

test("CLI --amount override (exact)", async () => {
  const { code, stdout } = await runCli(["--amount", "2"], SPEC);
  assert.equal(code, 0);
  const out = JSON.parse(stdout);
  assert.equal(out.mode, "exact");
  assert.equal(out.sent, 2);
  assert.equal(out.totalCost, 4); // two cheapest units via bob: (1+1) + (1+1)
});

test("CLI --at-most with negative fees sends the profitable amount", async () => {
  const spec = {
    source: "s",
    sink: "t",
    amount: 2,
    edges: [
      { from: "s", to: "t", capacity: 1, segments: [{ upTo: 1, unitCost: -3 }] },
      { from: "s", to: "t", capacity: 1, segments: [{ upTo: 1, unitCost: 4 }] },
    ],
  };
  const { code, stdout } = await runCli(["--at-most", "--enumerate"], spec);
  assert.equal(code, 0);
  const out = JSON.parse(stdout);
  assert.equal(out.mode, "at-most");
  assert.equal(out.sent, 1);
  assert.equal(out.totalCost, -3);
  assert.equal(out.enumeration.matches, true);
});

test("CLI exits 2 on infeasible and 1 on invalid input", async () => {
  const res1 = await runCli([], { ...SPEC, amount: 20 });
  assert.equal(res1.code, 2);
  assert.equal(JSON.parse(res1.stdout).status, "infeasible");

  const res2 = await runCli([], { ...SPEC, amount: 21 });
  assert.equal(res2.code, 1);

  const res3 = await runCli(["--amount", "-1"], SPEC);
  assert.equal(res3.code, 1);
});
