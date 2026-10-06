import { test } from "node:test";
import { deepEqual, equal, ok } from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Board } from "../src/board.ts";
import { runCli } from "../src/cli.ts";
import { LimitExceededError, Solver } from "../src/search.ts";
import type { BoardSpec } from "../src/types.ts";

const spec: BoardSpec = {
  width: 6,
  height: 4,
  player: [0, 1],
  enemies: [[1, 1], [3, 1], [5, 1], [2, 3]],
  obstacles: [[4, 3]],
  toggle: [0, 3],
  directionsA: [[1, 0], [-1, 0], [0, 1], [0, -1]],
  directionsB: [[1, 0], [0, -1]],
};

test("solver resumes from exported memo and matches one-shot run", () => {
  const board = new Board(spec);
  const oneShot = new Solver(board).solve();

  const limited = new Solver(board, { maxStates: 3 });
  let thrown = false;
  try {
    limited.solve();
  } catch (err) {
    thrown = err instanceof LimitExceededError;
  }
  ok(thrown, "expected LimitExceededError");

  const resumed = new Solver(board, { memo: new Map(limited.memo) }).solve();
  equal(resumed.captures, oneShot.captures);
  deepEqual(resumed.landings, oneShot.landings);
  deepEqual(resumed.actions, oneShot.actions);
});

test("CLI saves a snapshot on limit and resumes from it", () => {
  const dir = mkdtempSync(join(tmpdir(), "jumpforge-"));
  const puzzle = join(dir, "puzzle.json");
  const snap = join(dir, "snap.json");
  writeFileSync(puzzle, JSON.stringify(spec));

  const run = (args: string[]): { status: number; stdout: string; stderr: string } => {
    const out: string[] = [];
    const err: string[] = [];
    const status = runCli(args, {
      log: (m) => out.push(m),
      error: (m) => err.push(m),
    });
    return { status, stdout: out.join("\n"), stderr: err.join("\n") };
  };

  const first = run([puzzle, "--max-states", "2", "--snapshot", snap]);
  equal(first.status, 2);
  ok(first.stderr.includes("snapshot saved"));

  const second = run([puzzle, "--resume", snap, "--json"]);
  equal(second.status, 0);
  const cert = JSON.parse(second.stdout) as { optimal: number };

  const expected = new Solver(new Board(spec)).solve();
  equal(cert.optimal, expected.captures);
});
