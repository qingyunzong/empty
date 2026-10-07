import { test } from "node:test";
import { match, ok, equal } from "node:assert/strict";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import process from "node:process";
import { main } from "../src/cli.js";

const TMP = `/tmp/bool-mus-cli-test-${process.pid}`;

interface Captured {
  code: number;
  stdout: string;
  stderr: string;
}

function run(...args: string[]): Captured {
  const outLines: string[] = [];
  const errLines: string[] = [];
  let code = 0;
  try {
    code = main(args, {
      out: (line) => outLines.push(line),
      err: (line) => errLines.push(line),
    });
  } catch (err) {
    code = 2;
    errLines.push(`error: ${err instanceof Error ? err.message : String(err)}`);
  }
  return { code, stdout: outLines.join("\n"), stderr: errLines.join("\n") };
}

function write(name: string, content: string): string {
  const path = `${TMP}/${name}`;
  writeFileSync(path, content);
  return path;
}

test("cli end-to-end", () => {
  mkdirSync(TMP, { recursive: true });
  try {
    const unsat = write("unsat.txt", "c1: a | b\nc2: !a\nc3: !b & (a -> c)\nc4: !c\n");
    const sat = write("sat.txt", "c1: a | b\nc2: !a -> c\n");

    // SAT: lexicographically smallest assignment.
    const satOut = run("solve", sat);
    equal(satOut.code, 0);
    match(satOut.stdout, /SAT/);
    match(satOut.stdout, /lexicographically smallest assignment: a=0 b=1 c=1/);

    // UNSAT: minimum unsatisfiable subset plus a proof tree.
    const unsatOut = run("solve", unsat);
    match(unsatOut.stdout, /UNSAT/);
    match(unsatOut.stdout, /UNSAT \{c1, c2, c3\}.*size 3/);
    match(unsatOut.stdout, /├─ \{c2, c3\} SAT/);
    match(unsatOut.stdout, /└─ \{c1, c2\} SAT/);
    match(unsatOut.stdout, /minimality: all 11 subset\(s\) of size < 3/);

    // Independent verification: truth table + all smaller subsets.
    const verifyOut = run("verify", unsat);
    equal(verifyOut.code, 0);
    match(verifyOut.stdout, /PASS independent truth table/);
    match(verifyOut.stdout, /PASS all 11 subset\(s\) of size < 3 independently verified satisfiable/);
    match(verifyOut.stdout, /VERIFY OK/);
    equal(run("verify", sat).code, 0);
    match(run("verify", sat).stdout, /VERIFY OK/);

    // Named assumptions and the minimal-conflict cache.
    const state = `${TMP}/state.json`;
    const base = write("base.txt", "k1: a\n");
    match(run("solve", base, "--state", state).stdout, /SAT/);
    run("assume", "add", "h1", "!a", "--state", state);
    const withH1 = run("solve", base, "--state", state);
    match(withH1.stdout, /UNSAT \{h1, k1\}/);
    match(
      run("cache", "list", "--state", state).stdout,
      /reusable +constraints=\{k1\} assumptions=\{h1\}/
    );
    // Second solve reuses the cached conflict instead of searching.
    match(run("solve", base, "--state", state).stdout, /UNSAT \(cached conflict/);
    // Retracting the assumption invalidates exactly that conflict.
    run("assume", "remove", "h1", "--state", state);
    match(run("cache", "list", "--state", state).stdout, /invalidated constraints=\{k1\}/);
    match(run("solve", base, "--state", state).stdout, /SAT/);
    // Re-adding it makes the old conflict reusable again.
    run("assume", "add", "h1", "!a", "--state", state);
    match(run("solve", base, "--state", state).stdout, /UNSAT \(cached conflict/);

    // Pausable search: the frontier persists in the state file.
    const pauseState = `${TMP}/pause.json`;
    const paused = run("solve", unsat, "--state", pauseState, "--budget", "2");
    match(paused.stdout, /PAUSED at size=\d+ combo=\d+ row=\d+/);
    match(paused.stdout, /frontier persisted/);
    let resumed = run("resume", "--state", pauseState, "--budget", "2");
    let guard = 0;
    while (/PAUSED/.test(resumed.stdout) && guard++ < 1000) {
      resumed = run("resume", "--state", pauseState);
    }
    match(resumed.stdout, /UNSAT \{c1, c2, c3\}/);

    // Resuming without a paused search is an error.
    const noPause = run("resume", "--state", pauseState);
    equal(noPause.code, 2);
    match(noPause.stderr, /no paused search/);

    // Explicit input limits.
    const tooMany = write(
      "many.txt",
      Array.from({ length: 19 }, (_, i) => `c${i}: true`).join("\n") + "\n"
    );
    const failed = run("solve", tooMany);
    equal(failed.code, 2);
    match(failed.stderr, /exhaustive input limit exceeded: 19 named constraints/);
    match(run("limits").stdout, /max named constraints \(incl\. assumptions\): 18/);
    match(run("limits").stdout, /max variables: 20/);

    // Malformed input is rejected with a useful message.
    const bad = write("bad.txt", "c1 a & b\n");
    const badOut = run("solve", bad);
    equal(badOut.code, 2);
    match(badOut.stderr, /expected 'id: <expr>'/);
  } finally {
    rmSync(TMP, { recursive: true, force: true });
  }
});
