import test from "node:test";
import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  run,
  EXIT_EQUIVALENT,
  EXIT_DISTINGUISHED,
  EXIT_UNKNOWN,
  EXIT_ERROR,
} from "../src/cli";

interface Captured {
  code: number;
  stdout: string;
  stderr: string;
}

function runCli(argv: string[]): Captured {
  const outLines: string[] = [];
  const errLines: string[] = [];
  const code = run(argv, {
    out: (s) => outLines.push(s),
    err: (s) => errLines.push(s),
  });
  return { code, stdout: outLines.join("\n"), stderr: errLines.join("\n") };
}

function writeSpec(spec: unknown): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "proto-equiv-"));
  const file = path.join(dir, "spec.json");
  fs.writeFileSync(file, JSON.stringify(spec));
  return file;
}

const equivalentSpec = {
  alphabet: ["a", "b"],
  automata: [
    {
      name: "A",
      states: ["q0", "q1"],
      initial: "q0",
      accepting: ["q1"],
      transitions: [
        { from: "q0", on: "a", to: "q1", output: 1 },
        { from: "q1", on: "b", to: "q0", output: 0 },
      ],
    },
    {
      name: "B",
      states: ["p0", "p1"],
      initial: "p0",
      accepting: ["p1"],
      transitions: [
        { from: "p0", on: "a", to: "p1", output: 1 },
        { from: "p1", on: "b", to: "p0", output: 0 },
      ],
    },
  ],
};

test("equivalent automata: exit 0, certificate and enumeration check", () => {
  const { code, stdout } = runCli([writeSpec(equivalentSpec)]);
  assert.equal(code, EXIT_EQUIVALENT);
  assert.match(stdout, /Result: EQUIVALENT/);
  assert.match(stdout, /Certificate: \d+ reachable product configurations/);
  assert.match(stdout, /Enumeration check: \d+ words up to length \d+ verified - OK/);
});

test("distinguished automata: exit 1, shortest word and dual traces", () => {
  const spec = {
    alphabet: ["a", "b"],
    automata: [
      {
        name: "A",
        states: ["q0", "q1"],
        initial: "q0",
        accepting: ["q1"],
        transitions: [{ from: "q0", on: "b", to: "q1", output: null }],
      },
      { name: "B", states: ["p0"], initial: "p0", accepting: [], transitions: [] },
    ],
  };
  const { code, stdout } = runCli([writeSpec(spec)]);
  assert.equal(code, EXIT_DISTINGUISHED);
  assert.match(stdout, /Result: NOT EQUIVALENT/);
  assert.match(stdout, /acceptance mismatch/);
  assert.match(stdout, /Shortest distinguishing word.*: b/);
  assert.match(stdout, /Trace A:/);
  assert.match(stdout, /Trace B:/);
  assert.match(stdout, /rejecting sink/);
});

test("output mismatch via registers: exit 1 with both traces", () => {
  const spec = {
    alphabet: ["a"],
    registers: ["x"],
    automata: [
      {
        name: "A",
        states: ["q0"],
        initial: "q0",
        accepting: ["q0"],
        transitions: [{ from: "q0", on: "a", to: "q0", output: "x", update: { x: "x + 1" } }],
      },
      {
        name: "B",
        states: ["p0"],
        initial: "p0",
        accepting: ["p0"],
        transitions: [{ from: "p0", on: "a", to: "p0", output: "x", update: { x: "x + 2" } }],
      },
    ],
  };
  const { code, stdout } = runCli([writeSpec(spec)]);
  assert.equal(code, EXIT_DISTINGUISHED);
  assert.match(stdout, /output mismatch/);
  assert.match(stdout, /a a/);
  assert.match(stdout, /\{x=1\}/);
  assert.match(stdout, /\{x=2\}/);
});

test("budget exhaustion: exit 2 and never claims equivalence", () => {
  const mk = (name: string) => ({
    name,
    states: ["s0"],
    initial: "s0",
    accepting: ["s0"],
    transitions: [{ from: "s0", on: "a", to: "s0", output: 0, update: { x: "x + 1" } }],
  });
  const spec = { alphabet: ["a"], registers: ["x"], automata: [mk("A"), mk("B")] };
  const { code, stdout } = runCli([writeSpec(spec), "--budget", "10"]);
  assert.equal(code, EXIT_UNKNOWN);
  assert.match(stdout, /Result: UNKNOWN/);
  assert.match(stdout, /NOT established/);
  assert.ok(!/EQUIVALENT/.test(stdout.replace("NOT EQUIVALENT", "")));
});

test("usage and input errors exit 3", () => {
  assert.equal(runCli([]).code, EXIT_ERROR);
  assert.equal(runCli(["--nope"]).code, EXIT_ERROR);
  const bad = writeSpec("{ not json");
  assert.equal(runCli([bad]).code, EXIT_ERROR);
  const invalid = writeSpec({ alphabet: ["a"], automata: [] });
  const res = runCli([invalid]);
  assert.equal(res.code, EXIT_ERROR);
  assert.match(res.stderr, /spec error/);
});
