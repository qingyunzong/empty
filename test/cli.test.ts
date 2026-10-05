import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { writeFileSync } from "node:fs";

const CLI = ["dist/src/cli.js"];

function run(args: string[]) {
  return spawnSync("node", [...CLI, ...args], { encoding: "utf8" });
}

// Note: this environment's spawnSync cannot pipe `input` to a child, so
// stdin scenarios go through a temp file and shell redirection.
function runWithStdin(args: string[], input: string, tag: string) {
  const tmp = `dist/.test-stdin-${tag}.json`;
  writeFileSync(tmp, input);
  return spawnSync("bash", ["-c", `node ${CLI[0]} ${args.join(" ")} < ${tmp}`], { encoding: "utf8" });
}

test("CLI solves the feasible example and cross-checks with brute force", () => {
  const r = run(["examples/feasible.json", "--brute"]);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /status: optimal/);
  assert.match(r.stdout, /verification: ok/);
  assert.match(r.stdout, /brute force: agrees/);
  assert.match(r.stdout, /dual certificate:/);
});

test("CLI reports the Hall witness for the infeasible example", () => {
  const r = run(["examples/infeasible.json"]);
  assert.equal(r.status, 2, r.stderr);
  assert.match(r.stdout, /status: infeasible/);
  assert.match(r.stdout, /hall witness: orders \{W1, W2\} connect only to stations \{S1\}/);
  assert.match(r.stdout, /verification: ok/);
});

test("CLI reads from stdin and emits JSON", () => {
  const input = JSON.stringify({
    orders: ["A", "B"],
    stations: ["X", "Y"],
    costs: [
      [-5, -1],
      [-2, -9],
    ],
  });
  const r = runWithStdin(["-", "--json"], input, "stdin");
  assert.equal(r.status, 0, r.stderr);
  const out = JSON.parse(r.stdout);
  assert.equal(out.result.status, "optimal");
  assert.equal(out.result.cost, -14);
  assert.equal(out.verification, "ok");
});

test("CLI rejects invalid input with exit code 1", () => {
  const r = runWithStdin(["-"], JSON.stringify({ orders: ["A"], stations: ["X"], costs: [["?"]] }), "bad");
  assert.equal(r.status, 1);
  assert.match(r.stderr, /invalid input/);
});
