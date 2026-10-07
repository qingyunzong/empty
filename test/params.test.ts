import test from "node:test";
import { deepEqual, equal, match, ok } from "node:assert/strict";
import {
  resolve,
  type OptionSpec,
  type Resolved,
  type SourceRef,
} from "../src/params.js";

const specs: OptionSpec[] = [
  { name: "format", short: "f", type: "string", default: "text" },
  { name: "jobs", short: "j", type: "number", default: 1 },
  { name: "verbose", short: "v", type: "boolean", default: false },
  { name: "include", short: "I", type: "list", default: ["base"] },
  { name: "output", short: "o", type: "string" },
  { name: "json", type: "boolean" },
  { name: "yaml", type: "boolean" },
];

const run = (input: {
  config?: Record<string, unknown>;
  argv?: string[];
  mutexGroups?: string[][];
}): Resolved => resolve({ specs, ...input });

// ---------------------------------------------------------------------------
// Table-driven merge-combination verification: defaults x config x CLI.
// ---------------------------------------------------------------------------

interface MergeCase {
  name: string;
  config?: Record<string, unknown>;
  argv?: string[];
  wantValues: Record<string, unknown>;
  wantSources: Record<string, SourceRef>;
}

const mergeCases: MergeCase[] = [
  {
    name: "defaults only",
    wantValues: { format: "text", jobs: 1, verbose: false, include: ["base"] },
    wantSources: {
      format: { layer: "default", position: "default" },
      include: { layer: "default", position: "default" },
    },
  },
  {
    name: "config overrides default (single value)",
    config: { format: "json" },
    argv: [],
    wantValues: { format: "json" },
    wantSources: { format: { layer: "config", position: "config.format" } },
  },
  {
    name: "cli overrides config overrides default",
    config: { format: "json" },
    argv: ["--format", "xml"],
    wantValues: { format: "xml" },
    wantSources: { format: { layer: "cli", position: "argv[1]" } },
  },
  {
    name: "cli overrides default when config is silent",
    argv: ["--jobs", "8"],
    wantValues: { jobs: 8 },
    wantSources: { jobs: { layer: "cli", position: "argv[1]" } },
  },
  {
    name: "same layer: last single-value occurrence wins",
    argv: ["--format", "json", "--format", "yaml"],
    wantValues: { format: "yaml" },
    wantSources: { format: { layer: "cli", position: "argv[3]" } },
  },
  {
    name: "same layer: --name=value and short option share one layer",
    argv: ["-f", "json", "--format=yaml"],
    wantValues: { format: "yaml" },
    wantSources: { format: { layer: "cli", position: "argv[2]" } },
  },
  {
    name: "list accumulates within cli layer",
    argv: ["-I", "src", "--include", "test", "--include=lib"],
    wantValues: { include: ["src", "test", "lib"] },
    wantSources: { include: { layer: "cli", position: "argv[1]" } },
  },
  {
    name: "list accumulates within config layer",
    config: { include: ["a", "b"] },
    wantValues: { include: ["a", "b"] },
    wantSources: { include: { layer: "config", position: "config.include" } },
  },
  {
    name: "cli list replaces config list (no cross-layer accumulation)",
    config: { include: ["a", "b"] },
    argv: ["--include", "c"],
    wantValues: { include: ["c"] },
    wantSources: { include: { layer: "cli", position: "argv[1]" } },
  },
  {
    name: "config list replaces default list",
    config: { include: ["x"] },
    wantValues: { include: ["x"] },
    wantSources: { include: { layer: "config", position: "config.include" } },
  },
  {
    name: "cli list replaces default list",
    argv: ["--include", "only"],
    wantValues: { include: ["only"] },
    wantSources: { include: { layer: "cli", position: "argv[1]" } },
  },
  {
    name: "boolean negation and explicit value in cli",
    argv: ["--verbose", "--no-verbose", "--json=true"],
    wantValues: { verbose: false, json: true },
    wantSources: {
      verbose: { layer: "cli", position: "argv[1]" },
      json: { layer: "cli", position: "argv[2]" },
    },
  },
  {
    name: "config boolean beats cli-absent default, cli beats config",
    config: { verbose: true },
    argv: ["--no-verbose"],
    wantValues: { verbose: false },
    wantSources: { verbose: { layer: "cli", position: "argv[0]" } },
  },
  {
    name: "mixed layers across different options",
    config: { format: "json", jobs: 4 },
    argv: ["--jobs", "16", "-o", "out.txt"],
    wantValues: { format: "json", jobs: 16, output: "out.txt" },
    wantSources: {
      format: { layer: "config", position: "config.format" },
      jobs: { layer: "cli", position: "argv[1]" },
      output: { layer: "cli", position: "argv[3]" },
    },
  },
];

for (const tc of mergeCases) {
  test(`merge: ${tc.name}`, () => {
    const got = run({ ...(tc.config ? { config: tc.config } : {}), ...(tc.argv ? { argv: tc.argv } : {}) });
    deepEqual(got.errors, []);
    for (const [key, value] of Object.entries(tc.wantValues)) {
      deepEqual(got.values[key], value, `value of ${key}`);
    }
    for (const [key, ref] of Object.entries(tc.wantSources)) {
      deepEqual(got.sources[key], ref, `source of ${key}`);
    }
  });
}

// ---------------------------------------------------------------------------
// `--` terminates option parsing.
// ---------------------------------------------------------------------------

test("`--` terminates option parsing; rest are positionals", () => {
  const got = run({ argv: ["--format", "json", "--", "--jobs", "8", "file.txt"] });
  deepEqual(got.errors, []);
  equal(got.values.format, "json");
  equal(got.values.jobs, 1, "option after -- must not be parsed");
  deepEqual(got.positionals, ["--jobs", "8", "file.txt"]);
});

test("bare `--` alone yields empty positionals", () => {
  const got = run({ argv: ["--"] });
  deepEqual(got.errors, []);
  deepEqual(got.positionals, []);
});

// ---------------------------------------------------------------------------
// Mutex groups are evaluated on the final merged values.
// ---------------------------------------------------------------------------

interface MutexCase {
  name: string;
  config?: Record<string, unknown>;
  argv?: string[];
  wantError: boolean;
  errorMatch?: RegExp;
}

const mutexCases: MutexCase[] = [
  {
    name: "conflict across layers: config sets json, cli sets yaml",
    config: { json: true },
    argv: ["--yaml"],
    wantError: true,
    errorMatch: /--json \(config config\.json\).*--yaml \(cli argv\[0\]\)/,
  },
  {
    name: "conflict within cli layer",
    argv: ["--json", "--yaml"],
    wantError: true,
    errorMatch: /--json \(cli argv\[0\]\).*--yaml \(cli argv\[1\]\)/,
  },
  {
    name: "no conflict when only one member is set",
    argv: ["--json"],
    wantError: false,
  },
  {
    name: "no conflict when neither member is set",
    wantError: false,
  },
  {
    name: "defaults never trigger a mutex conflict",
    config: { json: true },
    wantError: false,
  },
  {
    name: "explicitly disabling one member resolves the conflict",
    config: { json: true },
    argv: ["--no-json", "--yaml"],
    wantError: true, // json is still explicitly set (to false) by cli
    errorMatch: /mutually exclusive/,
  },
];

for (const tc of mutexCases) {
  test(`mutex: ${tc.name}`, () => {
    const got = run({
      ...(tc.config ? { config: tc.config } : {}),
      ...(tc.argv ? { argv: tc.argv } : {}),
      mutexGroups: [["json", "yaml"]],
    });
    const mutexErrors = got.errors.filter((e) => e.message.includes("mutually exclusive"));
    if (tc.wantError) {
      equal(mutexErrors.length, 1, "expected exactly one mutex error");
      const err = mutexErrors[0];
      ok(err);
      if (tc.errorMatch) match(err.message, tc.errorMatch);
      ok(err.source !== null, "mutex error carries the offending source");
    } else {
      deepEqual(mutexErrors, []);
    }
  });
}

// ---------------------------------------------------------------------------
// Error positions: every error points at the offending argument.
// ---------------------------------------------------------------------------

interface ErrorCase {
  name: string;
  config?: Record<string, unknown>;
  argv?: string[];
  mutexGroups?: string[][];
  want: { message: RegExp; source: SourceRef | null }[];
}

const errorCases: ErrorCase[] = [
  {
    name: "unknown long option reports its argv index",
    argv: ["--format", "json", "--nope"],
    want: [{ message: /unknown option --nope/, source: { layer: "cli", position: "argv[2]" } }],
  },
  {
    name: "unknown short option reports its argv index",
    argv: ["-z"],
    want: [{ message: /unknown option -z/, source: { layer: "cli", position: "argv[0]" } }],
  },
  {
    name: "missing value at end of argv",
    argv: ["--format", "json", "--output"],
    want: [
      { message: /option --output: missing value/, source: { layer: "cli", position: "argv[2]" } },
    ],
  },
  {
    name: "missing value before another option",
    argv: ["--output", "--verbose"],
    want: [
      { message: /option --output: missing value/, source: { layer: "cli", position: "argv[0]" } },
    ],
  },
  {
    name: "invalid number reports the value token position",
    argv: ["--jobs", "abc"],
    want: [
      {
        message: /option --jobs: invalid number "abc"/,
        source: { layer: "cli", position: "argv[1]" },
      },
    ],
  },
  {
    name: "unknown config key reports config path",
    config: { forma: "json" },
    want: [
      { message: /unknown config key "forma"/, source: { layer: "config", position: "config.forma" } },
    ],
  },
  {
    name: "wrong config type reports config path",
    config: { jobs: "four" },
    want: [
      {
        message: /config key "jobs": expected number, got string/,
        source: { layer: "config", position: "config.jobs" },
      },
    ],
  },
  {
    name: "config list with non-string element reports config path",
    config: { include: ["ok", 5] },
    want: [
      {
        message: /config key "include": expected string array, got number element/,
        source: { layer: "config", position: "config.include" },
      },
    ],
  },
  {
    name: "mutex group referencing unknown option is a spec error",
    argv: [],
    mutexGroups: [["json", "nope"]],
    want: [{ message: /mutex group references unknown option "nope"/, source: null }],
  },
];

for (const tc of errorCases) {
  test(`error: ${tc.name}`, () => {
    const got = run({
      ...(tc.config ? { config: tc.config } : {}),
      ...(tc.argv ? { argv: tc.argv } : {}),
      ...(tc.mutexGroups ? { mutexGroups: tc.mutexGroups } : {}),
    });
    equal(got.errors.length, tc.want.length, "error count");
    tc.want.forEach((want, i) => {
      const err = got.errors[i];
      ok(err, `error #${i} exists`);
      match(err.message, want.message);
      deepEqual(err.source, want.source, `source of error #${i}`);
    });
  });
}

// ---------------------------------------------------------------------------
// Positionals and misc parsing behaviour.
// ---------------------------------------------------------------------------

test("non-option tokens before `--` are positionals", () => {
  const got = run({ argv: ["input.txt", "--verbose"] });
  deepEqual(got.errors, []);
  deepEqual(got.positionals, ["input.txt"]);
  equal(got.values.verbose, true);
});

test("bundled short booleans and attached short value", () => {
  const got = run({ argv: ["-v", "-fjson", "-j", "4"] });
  deepEqual(got.errors, []);
  equal(got.values.verbose, true);
  equal(got.values.format, "json");
  equal(got.values.jobs, 4);
});

test("negative numbers are accepted as option values", () => {
  const got = run({ argv: ["--jobs", "-2"] });
  deepEqual(got.errors, []);
  equal(got.values.jobs, -2);
});
