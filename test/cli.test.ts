/**
 * End-to-end CLI tests. The CLI entry `run()` is invoked in-process with
 * captured I/O, which exercises the full pipeline: argument parsing,
 * spec loading, constraint parsing, solving, serialization, exit codes.
 * (Child-process spawning is avoided because the sandbox does not
 * reliably propagate stdio pipes to grandchild processes.)
 */
import test from "node:test";
import assert from "node:assert/strict";
import { writeFileSync, unlinkSync } from "node:fs";
import { run, type CliIO } from "../src/cli.js";

function makeIO(stdin?: string): { io: CliIO; out: () => string; err: () => string } {
  let out = "";
  let err = "";
  return {
    io: {
      stdout: (s) => {
        out += s;
      },
      stderr: (s) => {
        err += s;
      },
      readStdin: () => {
        if (stdin === undefined) throw new Error("stdin was not expected to be read");
        return stdin;
      },
    },
    out: () => out,
    err: () => err,
  };
}

test("solve a single-variable system via flags", () => {
  const { io, out } = makeIO();
  const code = run(
    ["solve", "--var", "x:[0,100]", "-c", "2*x + 3 <= 50", "-c", "x % 7 == 3"],
    io,
  );
  assert.equal(code, 0);
  const result = JSON.parse(out());
  assert.equal(result.status, "sat");
  // 2x+3<=50 -> x<=23; x ≡ 3 (mod 7) -> 3, 10, 17
  assert.deepEqual(result.solutions.x, { start: "3", end: "17", step: "7", count: "3" });
});

test("unsat system exits 1 and prints a certificate", () => {
  const { io, out } = makeIO();
  const code = run(["solve", "--var", "x:[0,10]", "-c", "x % 4 == 1", "-c", "x % 6 == 2"], io);
  assert.equal(code, 1);
  const result = JSON.parse(out());
  assert.equal(result.status, "unsat");
  assert.equal(result.variable, "x");
  assert.equal(result.certificate.type, "crt-conflict");
  assert.equal(result.certificate.gcd, "2");
});

test("strict bound at INT64_MAX stays exact through the CLI", () => {
  const { io, out } = makeIO();
  const code = run(
    [
      "solve",
      "--var",
      "x:[-9223372036854775808,9223372036854775807]",
      "-c",
      "x < 9223372036854775807",
    ],
    io,
  );
  assert.equal(code, 0);
  const result = JSON.parse(out());
  assert.equal(result.solutions.x.end, "9223372036854775806");
  assert.equal(result.solutions.x.count, "18446744073709551615");
});

test("JSON spec from stdin with --enumerate", () => {
  const spec = JSON.stringify({
    variables: { x: ["0", "20"] },
    constraints: ["x % 4 == 1"],
  });
  const { io, out } = makeIO(spec);
  const code = run(["solve", "--file", "-", "--enumerate"], io);
  assert.equal(code, 0);
  const result = JSON.parse(out());
  assert.deepEqual(result.solutions.x.values, ["1", "5", "9", "13", "17"]);
});

test("JSON spec from a real file, multiple variables", () => {
  const path = new URL("./tmp-spec.json", import.meta.url).pathname;
  writeFileSync(
    path,
    JSON.stringify({
      variables: { x: ["0", "10"], y: ["-5", "5"] },
      constraints: ["x >= 2", "y % 3 == 0"],
    }),
  );
  try {
    const { io, out } = makeIO();
    const code = run(["solve", "--file", path], io);
    assert.equal(code, 0);
    const result = JSON.parse(out());
    assert.deepEqual(result.solutions.x, { start: "2", end: "10", step: "1", count: "9" });
    assert.deepEqual(result.solutions.y, { start: "-3", end: "3", step: "3", count: "3" });
  } finally {
    unlinkSync(path);
  }
});

test("invalid input exits 2 with a message on stderr", () => {
  const cases: string[][] = [
    ["solve", "--var", "x:[0,10]", "-c", "x != 3"], // unsupported operator
    ["solve", "--var", "x:[0,10]", "-c", "x + y <= 3"], // unknown variable y
    ["solve", "--var", "x:[0,9223372036854775808]"], // outside int64
    ["solve", "--var", "x:[5,1]"], // empty domain
    ["solve", "--bogus"], // unknown option
    ["solve", "--var", "x:[0,10]", "-c", "x*x <= 4"], // non-linear
  ];
  for (const args of cases) {
    const { io, err } = makeIO();
    assert.equal(run(args, io), 2, args.join(" "));
    assert.ok(err().length > 0, `stderr expected for ${args.join(" ")}`);
  }
});

test("mixed-variable constraint over declared variables exits 2", () => {
  const { io } = makeIO();
  const code = run(
    ["solve", "--var", "x:[0,9]", "--var", "y:[0,9]", "-c", "x + y <= 5"],
    io,
  );
  assert.equal(code, 2);
});

test("--pretty prints a human-readable summary", () => {
  const { io, out } = makeIO();
  const code = run(["solve", "--var", "x:[0,20]", "-c", "x % 4 == 1", "--pretty"], io);
  assert.equal(code, 0);
  assert.match(out(), /SAT/);
  assert.match(out(), /start=1, end=17, step=4, count=5/);
});

test("--enumerate caps large solution sets", () => {
  const { io, out } = makeIO();
  const code = run(["solve", "--var", "x:[0,100000]", "--enumerate=10"], io);
  assert.equal(code, 0);
  const result = JSON.parse(out());
  assert.match(result.solutions.x.valuesOmitted, /exceeds/);
});

test("--help exits 0", () => {
  const { io, out } = makeIO();
  assert.equal(run(["--help"], io), 0);
  assert.match(out(), /Usage:/);
});
