import test from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as childProcess from "node:child_process";

const CLI = path.join(__dirname, "..", "src", "cli.js");

function makeTempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "descparse-"));
}

function shQuote(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

// Spawn the CLI through a shell with output redirected to files: in some
// sandboxed environments a grandchild node's piped stdio is lost, while
// writes to regular files work reliably.
function runCli(args: string[]): { status: number; stdout: string; stderr: string } {
  const dir = makeTempDir();
  const outPath = path.join(dir, "out.txt");
  const errPath = path.join(dir, "err.txt");
  const codePath = path.join(dir, "code.txt");
  const cmd =
    [process.execPath, CLI, ...args].map(shQuote).join(" ") +
    ` > ${shQuote(outPath)} 2> ${shQuote(errPath)}; echo $? > ${shQuote(codePath)}`;
  childProcess.spawnSync("sh", ["-c", cmd], { stdio: "inherit" });
  return {
    status: Number(fs.readFileSync(codePath, "utf8").trim()),
    stdout: fs.readFileSync(outPath, "utf8"),
    stderr: fs.readFileSync(errPath, "utf8"),
  };
}

const FORMAT = {
  root: {
    fields: [
      { name: "magic", type: "uint16be" },
      { name: "count", type: "uint8" },
      { name: "items", type: "array", count: { ref: "count" }, element: { type: "uint8" } },
      { name: "tag", type: "uint8" },
      { name: "payload", type: "bytes", length: 2, when: { ref: "tag", eq: 1 } },
    ],
  },
};

test("cli parses a binary file and prints JSON", () => {
  const dir = makeTempDir();
  const fmtPath = path.join(dir, "fmt.json");
  const binPath = path.join(dir, "data.bin");
  fs.writeFileSync(fmtPath, JSON.stringify(FORMAT));
  fs.writeFileSync(binPath, new Uint8Array([0xca, 0xfe, 3, 10, 20, 30, 1, 0xaa, 0xbb]));

  const res = runCli(["--format", fmtPath, "--input", binPath]);
  assert.equal(res.status, 0, res.stderr);
  assert.deepStrictEqual(JSON.parse(res.stdout), {
    magic: 0xcafe,
    count: 3,
    items: [10, 20, 30],
    tag: 1,
    payload: "hex:aabb",
  });
});

test("cli omits conditionally absent fields", () => {
  const dir = makeTempDir();
  const fmtPath = path.join(dir, "fmt.json");
  const binPath = path.join(dir, "data.bin");
  fs.writeFileSync(fmtPath, JSON.stringify(FORMAT));
  fs.writeFileSync(binPath, new Uint8Array([0xca, 0xfe, 1, 42, 0]));

  const res = runCli(["--format", fmtPath, "--input", binPath]);
  assert.equal(res.status, 0, res.stderr);
  const parsed = JSON.parse(res.stdout);
  assert.equal(parsed.tag, 0);
  assert.ok(!("payload" in parsed));
});

test("cli exits 1 with offset on truncated input", () => {
  const dir = makeTempDir();
  const fmtPath = path.join(dir, "fmt.json");
  const binPath = path.join(dir, "data.bin");
  fs.writeFileSync(fmtPath, JSON.stringify(FORMAT));
  fs.writeFileSync(binPath, new Uint8Array([0xca, 0xfe, 3, 10]));

  const res = runCli(["--format", fmtPath, "--input", binPath]);
  assert.equal(res.status, 1);
  assert.match(res.stderr, /parse error at offset 3/);
});

test("cli exits 2 on a cyclic format definition", () => {
  const dir = makeTempDir();
  const fmtPath = path.join(dir, "fmt.json");
  const binPath = path.join(dir, "data.bin");
  fs.writeFileSync(
    fmtPath,
    JSON.stringify({
      definitions: {
        a: { fields: [{ name: "b", type: "ref", ref: "b" }] },
        b: { fields: [{ name: "a", type: "ref", ref: "a" }] },
      },
      root: "a",
    }),
  );
  fs.writeFileSync(binPath, new Uint8Array([0]));

  const res = runCli(["--format", fmtPath, "--input", binPath]);
  assert.equal(res.status, 2);
  assert.match(res.stderr, /format error: definition cycle detected/);
});

test("cli exits 2 on missing arguments", () => {
  const res = runCli([]);
  assert.equal(res.status, 2);
  assert.match(res.stderr, /usage:/);
});
