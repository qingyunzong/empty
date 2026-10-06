import { test } from "node:test";
import { deepStrictEqual, equal, ok } from "node:assert/strict";
import { unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { runCli } from "../src/cli.js";
import { contents, setupDir } from "./util.js";

interface RunResult {
  code: number;
  stdout: string;
  stderr: string;
}

function run(args: string[], cwd: string): RunResult {
  const outLines: string[] = [];
  const errLines: string[] = [];
  const code = runCli(args, {
    out: (line) => outLines.push(line),
    err: (line) => errLines.push(line),
  });
  return { code, stdout: outLines.join("\n"), stderr: errLines.join("\n") };
}

function writeMapping(mapping: unknown): string {
  const file = join(setupDir({}), "mapping.json");
  writeFileSync(file, JSON.stringify(mapping));
  return file;
}

test("end-to-end: plan, apply, verify, rollback", () => {
  const dir = setupDir({ "a.jpg": "1", "b.jpg": "2" });
  const mappingFile = writeMapping({
    caseFold: true,
    renames: [
      { from: "a.jpg", to: "b.jpg" },
      { from: "b.jpg", to: "a.jpg" },
    ],
  });

  const planned = run(["plan", mappingFile, "--dir", dir], dir);
  equal(planned.code, 0);
  ok(planned.stdout.includes("[temp]"));

  const applied = run(["apply", "--dir", dir], dir);
  equal(applied.code, 0);
  deepStrictEqual(contents(dir), { "a.jpg": "2", "b.jpg": "1" });

  const verified = run(["verify", "--dir", dir], dir);
  equal(verified.code, 0, verified.stderr);
  ok(verified.stdout.includes("verification passed"));

  const rolledBack = run(["rollback", "--dir", dir], dir);
  equal(rolledBack.code, 0);
  deepStrictEqual(contents(dir), { "a.jpg": "1", "b.jpg": "2" });
});

test("plan exits with code 2 on conflicts and changes nothing", () => {
  const dir = setupDir({ "a.jpg": "1", "stranger.jpg": "unknown" });
  const mappingFile = writeMapping({ caseFold: true, renames: [{ from: "a.jpg", to: "stranger.jpg" }] });
  const result = run(["plan", mappingFile, "--dir", dir], dir);
  equal(result.code, 2);
  ok(result.stderr.includes("already exists"));
  deepStrictEqual(contents(dir), { "a.jpg": "1", "stranger.jpg": "unknown" });
});

test("status reports journal progress", () => {
  const dir = setupDir({ "a.jpg": "1" });
  const mappingFile = writeMapping({ renames: [{ from: "a.jpg", to: "b.jpg" }] });
  run(["plan", mappingFile, "--dir", dir], dir);
  const status = run(["status", "--dir", dir], dir);
  equal(status.code, 0);
  ok(status.stdout.includes("1 pending"));
});

test("verify exits with code 3 on tampered state", () => {
  const dir = setupDir({ "a.jpg": "1" });
  const mappingFile = writeMapping({ renames: [{ from: "a.jpg", to: "b.jpg" }] });
  run(["plan", mappingFile, "--dir", dir], dir);
  run(["apply", "--dir", dir], dir);
  unlinkSync(join(dir, "b.jpg"));
  const failed = run(["verify", "--dir", dir], dir);
  equal(failed.code, 3);
});
