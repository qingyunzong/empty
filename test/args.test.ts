import { test } from "node:test";
import assert from "node:assert/strict";
import {
  ArgsError,
  parse,
  type ConflictEntry,
  type Location,
  type Schema,
  type Value,
} from "../src/args.js";

const schema: Schema = {
  options: [
    { name: "mode", type: "string", default: "dev" },
    { name: "port", type: "number", default: 80 },
    { name: "verbose", type: "boolean", default: false },
    { name: "tag", type: "list", default: ["base"] },
    { name: "output", type: "string", short: "o" },
    { name: "format", type: "string" },
  ],
  mutexGroups: [{ name: "out", options: ["output", "format"] }],
};

interface ExpectOk {
  values: Record<string, Value>;
  sources?: Record<string, { source: string; location: Location }>;
  positionals?: string[];
}

interface ExpectErr {
  messageIncludes: string[];
  location?: Location;
  conflicts?: ConflictEntry[];
}

interface Case {
  name: string;
  schema?: Schema;
  config?: Record<string, unknown>;
  argv?: string[];
  expect?: ExpectOk;
  expectError?: ExpectErr;
}

const cli = (index: number, token: string): Location => ({ kind: "cli", index, token });
const cfg = (key: string): Location => ({ kind: "config", key });
const dft: Location = { kind: "default" };

const cases: Case[] = [
  // --- scalar merging: highest layer wins, last occurrence within a layer ---
  {
    name: "defaults only",
    expect: {
      values: { mode: "dev", port: 80, verbose: false, tag: ["base"] },
      sources: {
        mode: { source: "default", location: dft },
        port: { source: "default", location: dft },
        verbose: { source: "default", location: dft },
        tag: { source: "default", location: dft },
      },
      positionals: [],
    },
  },
  {
    name: "config overrides scalar default",
    config: { mode: "prod" },
    expect: {
      values: { mode: "prod", port: 80, verbose: false, tag: ["base"] },
      sources: { mode: { source: "config", location: cfg("mode") } },
    },
  },
  {
    name: "cli overrides config and default",
    config: { mode: "prod" },
    argv: ["--mode", "staging"],
    expect: {
      values: { mode: "staging" },
      sources: { mode: { source: "cli", location: cli(0, "--mode") } },
    },
  },
  {
    name: "scalar: last occurrence within cli wins",
    argv: ["--mode", "a", "--mode", "b"],
    expect: {
      values: { mode: "b" },
      sources: { mode: { source: "cli", location: cli(2, "--mode") } },
    },
  },
  {
    name: "scalar: --opt=value form",
    argv: ["--port=8080"],
    expect: {
      values: { port: 8080 },
      sources: { port: { source: "cli", location: cli(0, "--port=8080") } },
    },
  },
  // --- list merging: accumulate within a layer, upper layer replaces ---
  {
    name: "list: repeated flags accumulate within cli",
    argv: ["--tag", "x", "--tag", "y"],
    expect: {
      values: { tag: ["x", "y"] },
      sources: { tag: { source: "cli", location: cli(2, "--tag") } },
    },
  },
  {
    name: "list: cli layer replaces config layer entirely",
    config: { tag: ["c1", "c2"] },
    argv: ["--tag", "x"],
    expect: {
      values: { tag: ["x"] },
      sources: { tag: { source: "cli", location: cli(0, "--tag") } },
    },
  },
  {
    name: "list: config layer replaces default layer",
    config: { tag: ["c1", "c2"] },
    expect: {
      values: { tag: ["c1", "c2"] },
      sources: { tag: { source: "config", location: cfg("tag") } },
    },
  },
  {
    name: "list: cli accumulates and replaces config+default",
    config: { tag: ["c1"] },
    argv: ["--tag", "x", "--tag", "y", "--tag", "z"],
    expect: {
      values: { tag: ["x", "y", "z"] },
      sources: { tag: { source: "cli", location: cli(4, "--tag") } },
    },
  },
  // --- `--` terminates option parsing ---
  {
    name: "double dash: tokens after -- are positionals",
    argv: ["--mode", "x", "--", "--tag", "y"],
    expect: {
      values: { mode: "x", tag: ["base"] },
      sources: {
        mode: { source: "cli", location: cli(0, "--mode") },
        tag: { source: "default", location: dft },
      },
      positionals: ["--tag", "y"],
    },
  },
  {
    name: "double dash: bare tokens before it are also positional",
    argv: ["file.txt", "--mode", "x", "--", "-o"],
    expect: {
      values: { mode: "x" },
      positionals: ["file.txt", "-o"],
    },
  },
  // --- booleans and short options ---
  {
    name: "boolean flag and negation",
    argv: ["--verbose"],
    expect: {
      values: { verbose: true },
      sources: { verbose: { source: "cli", location: cli(0, "--verbose") } },
    },
  },
  {
    name: "boolean negation overrides config true",
    config: { verbose: true },
    argv: ["--no-verbose"],
    expect: {
      values: { verbose: false },
      sources: { verbose: { source: "cli", location: cli(0, "--no-verbose") } },
    },
  },
  {
    name: "short option with separate value",
    argv: ["-o", "a.txt"],
    expect: {
      values: { output: "a.txt" },
      sources: { output: { source: "cli", location: cli(0, "-o") } },
    },
  },
  {
    name: "short option with = value",
    argv: ["-o=b.txt"],
    expect: {
      values: { output: "b.txt" },
      sources: { output: { source: "cli", location: cli(0, "-o=b.txt") } },
    },
  },
  // --- mutex groups on final merged values ---
  {
    name: "mutex: only one option set is fine",
    config: { output: "a.txt" },
    expect: {
      values: { output: "a.txt" },
      sources: { output: { source: "config", location: cfg("output") } },
    },
  },
  {
    name: "mutex: defaults on both sides do not conflict",
    schema: {
      options: [
        { name: "json", type: "boolean", default: true },
        { name: "yaml", type: "boolean", default: false },
      ],
      mutexGroups: [{ name: "fmt", options: ["json", "yaml"] }],
    },
    expect: {
      values: { json: true, yaml: false },
      sources: {
        json: { source: "default", location: dft },
        yaml: { source: "default", location: dft },
      },
    },
  },
  {
    name: "mutex: config vs cli conflict reports both origins",
    config: { output: "a.txt" },
    argv: ["--format", "json"],
    expectError: {
      messageIncludes: ["out", "--output", "config key 'output'", "--format", "argv[0]"],
      conflicts: [
        { option: "output", origin: { source: "config", location: cfg("output") } },
        { option: "format", origin: { source: "cli", location: cli(0, "--format") } },
      ],
    },
  },
  {
    name: "mutex: conflict survives layer replacement of a third option",
    config: { output: "a.txt", mode: "prod" },
    argv: ["--format", "json", "--mode", "dev"],
    expectError: {
      messageIncludes: ["mutually exclusive", "--output", "--format"],
    },
  },
  // --- errors carry parameter positions ---
  {
    name: "error: unknown cli option reports argv index",
    argv: ["--mode", "x", "--nope"],
    expectError: {
      messageIncludes: ["unknown option", "--nope"],
      location: cli(2, "--nope"),
    },
  },
  {
    name: "error: unknown config key reports the key",
    config: { nope: 1 },
    expectError: {
      messageIncludes: ["unknown option", "nope"],
      location: cfg("nope"),
    },
  },
  {
    name: "error: missing value reports the flag position",
    argv: ["--mode"],
    expectError: {
      messageIncludes: ["requires a value", "--mode"],
      location: cli(0, "--mode"),
    },
  },
  {
    name: "error: invalid number reports the value position",
    argv: ["--port", "abc"],
    expectError: {
      messageIncludes: ["expects a number", "abc"],
      location: cli(1, "abc"),
    },
  },
  {
    name: "error: config list with wrong type reports the key",
    config: { tag: "x" },
    expectError: {
      messageIncludes: ["string array", "tag"],
      location: cfg("tag"),
    },
  },
  {
    name: "error: boolean given a value",
    argv: ["--verbose=yes"],
    expectError: {
      messageIncludes: ["does not take a value", "verbose"],
      location: cli(0, "--verbose=yes"),
    },
  },
  {
    name: "error: --no- on a non-boolean option",
    argv: ["--no-mode"],
    expectError: {
      messageIncludes: ["only valid for boolean", "--no-mode"],
      location: cli(0, "--no-mode"),
    },
  },
];

for (const c of cases) {
  test(c.name, () => {
    const run = () => parse(c.schema ?? schema, c.config ?? {}, c.argv ?? []);
    if (c.expectError) {
      let err: unknown;
      try {
        run();
      } catch (e) {
        err = e;
      }
      if (!(err instanceof ArgsError)) {
        throw new Error(`expected ArgsError, got: ${String(err)}`);
      }
      for (const part of c.expectError.messageIncludes) {
        assert.ok(
          err.message.includes(part),
          `message ${JSON.stringify(err.message)} missing ${JSON.stringify(part)}`,
        );
      }
      if (c.expectError.location !== undefined) {
        assert.deepEqual(err.location, c.expectError.location);
      }
      if (c.expectError.conflicts !== undefined) {
        assert.deepEqual(err.conflicts, c.expectError.conflicts);
      }
      return;
    }
    const result = run();
    const expected = c.expect as ExpectOk;
    for (const [key, value] of Object.entries(expected.values)) {
      assert.deepEqual(result.values[key], value, `value of '${key}'`);
    }
    for (const [key, origin] of Object.entries(expected.sources ?? {})) {
      assert.deepEqual(result.sources[key], origin, `source of '${key}'`);
    }
    if (expected.positionals !== undefined) {
      assert.deepEqual(result.positionals, expected.positionals);
    }
  });
}
