import { test } from "node:test";
import { deepEqual, equal, ok } from "node:assert/strict";
import { spawn } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { buildCertificate, verifyCertificate, type Certificate } from "../src/certificate.js";
import { run, type CliIO } from "../src/cli.js";
import { parseProblem } from "../src/types.js";

function capture(): { io: CliIO; out: () => string; err: () => string } {
  let o = "";
  let e = "";
  return {
    io: { stdout: (s) => { o += s; }, stderr: (s) => { e += s; } },
    out: () => o,
    err: () => e,
  };
}

function loadSmall() {
  return parseProblem(JSON.parse(readFileSync("examples/small.json", "utf8")));
}

test("end-to-end: certificate for examples/small.json verifies cleanly", () => {
  const problem = loadSmall();
  const cert = buildCertificate(problem, { enumerate: true, bruteForce: true });
  ok(cert.coverage.feasible, cert.coverage.reason);
  ok(cert.schedule !== null);
  ok(cert.schedule!.feasible, cert.schedule!.reason);
  ok(cert.coverage.enumeration.checked);
  ok(cert.coverage.enumeration.matchesSolver, "enumeration must confirm DP optimum");
  ok(cert.schedule!.bruteForce.checked);
  ok(cert.schedule!.bruteForce.matchesSolver, "brute force must confirm DP peak");
  ok(cert.schedule!.lowerBound <= cert.schedule!.peak);
  ok(cert.schedule!.peak <= cert.schedule!.upperBound);
  deepEqual(verifyCertificate(problem, cert), []);
});

test("CLI plan prints a JSON certificate to stdout", () => {
  const c = capture();
  const code = run(["plan", "examples/small.json", "--enumerate"], c.io);
  equal(code, 0);
  const cert = JSON.parse(c.out()) as Certificate;
  equal(cert.version, 1);
  ok(cert.coverage.feasible);
  ok(cert.coverage.enumeration.matchesSolver);
  ok(c.err().includes("cover:"));
});

test("CLI plan --out writes the certificate, verify accepts it", () => {
  const path = "/tmp/cert-small.json";
  const c1 = capture();
  equal(run(["plan", "examples/small.json", "--enumerate", "--out", path], c1.io), 0);
  const c2 = capture();
  equal(run(["verify", "examples/small.json", path], c2.io), 0);
  ok(c2.err().includes("certificate valid"));
});

test("CLI plan exits 1 on infeasible coverage and still emits the certificate", () => {
  const c = capture();
  const code = run(["plan", "examples/infeasible.json"], c.io);
  equal(code, 1);
  const cert = JSON.parse(c.out()) as Certificate;
  ok(!cert.coverage.feasible);
  ok(cert.coverage.reason.includes("[30,50)"), cert.coverage.reason);
});

test("CLI verify exits 2 on a tampered certificate", () => {
  const path = "/tmp/cert-tampered.json";
  const c1 = capture();
  equal(run(["plan", "examples/small.json", "--out", path], c1.io), 0);
  const cert = JSON.parse(readFileSync(path, "utf8")) as Certificate;
  cert.coverage.totalBytes -= 1;
  writeFileSync(path, JSON.stringify(cert));
  const c2 = capture();
  equal(run(["verify", "examples/small.json", path], c2.io), 2);
  ok(c2.err().includes("invalid:"));
});

test("tampered schedule peak fails in-process verification", () => {
  const problem = loadSmall();
  const cert = buildCertificate(problem, { enumerate: false, bruteForce: false });
  cert.schedule!.peak += 1;
  const errors = verifyCertificate(problem, cert);
  ok(errors.length > 0, "tampered peak must be detected");
});

test("CLI as a subprocess: plan --out then verify (exit codes)", async () => {
  const path = "/tmp/cert-subprocess.json";
  const runChild = (args: string[]): Promise<number | null> =>
    new Promise((resolve, reject) => {
      const child = spawn("node", ["dist/src/cli.js", ...args]);
      child.on("error", reject);
      child.on("close", resolve);
    });
  equal(await runChild(["plan", "examples/small.json", "--out", path]), 0);
  equal(await runChild(["verify", "examples/small.json", path]), 0);
  const cert = JSON.parse(readFileSync(path, "utf8")) as Certificate;
  ok(cert.coverage.feasible);
});
