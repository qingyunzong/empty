import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { runCli } from "../src/cli.js";

function tmpdir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "moldplan-"));
}

// Drive the CLI in-process (sandbox forbids child processes); each call is a
// full stateless CLI invocation equivalent to `moldplan <args>`.
function run(args) {
  const lines = { stdout: [], stderr: [] };
  const code = runCli(args, {
    out: (obj) => lines.stdout.push(JSON.stringify(obj)),
    err: (obj) => lines.stderr.push(JSON.stringify(obj)),
  });
  return { code, stdout: lines.stdout.join("\n"), stderr: lines.stderr.join("\n") };
}

function writeLines(file, lines) {
  fs.writeFileSync(file, lines.join("\n") + "\n");
}

const BASE = [
  { type: "machine", id: "M1" },
  { type: "machine", id: "M2" },
  { type: "mold", id: "F1", cycle: 2 },
  { type: "mold", id: "F2", cycle: 3 },
  { type: "setup", from: "F1", to: "F2", time: 4 },
  { type: "setup", from: "F2", to: "F1", time: 5 },
  { type: "order", id: "O1", mold: "F1", qty: 4, due: 200, person: "P1" },
  { type: "order", id: "O2", mold: "F2", qty: 3, due: 200, person: "P2" },
];

function initState(dir, lines = BASE) {
  const input = path.join(dir, "base.jsonl");
  writeLines(input, lines.map((l) => JSON.stringify(l)));
  const state = path.join(dir, "st");
  const r = run(["plan", "--input", input, "--state", state]);
  assert.equal(r.code, 0, r.stderr);
  return state;
}

// ---------- invalid input: exit 2 with {code, at} ----------

test("malformed JSONL -> exit 2 with JSON {code,at} on stderr", () => {
  const dir = tmpdir();
  const input = path.join(dir, "bad.jsonl");
  writeLines(input, ['{"type":"machine","id":"M1"}', "{not json"]);
  const r = run(["plan", "--input", input, "--state", path.join(dir, "st")]);
  assert.equal(r.code, 2);
  const err = JSON.parse(r.stderr);
  assert.equal(err.code, "PARSE_ERROR");
  assert.match(err.at, /bad\.jsonl:2/);
});

test("schema violation -> exit 2", () => {
  const dir = tmpdir();
  const input = path.join(dir, "bad.jsonl");
  writeLines(input, ['{"type":"machine","id":"M1"}', '{"type":"order","id":"O1","mold":"F1","qty":-3,"due":10,"person":"P1"}']);
  const r = run(["plan", "--input", input, "--state", path.join(dir, "st")]);
  assert.equal(r.code, 2);
  const err = JSON.parse(r.stderr);
  assert.equal(err.code, "SCHEMA");
  assert.ok(err.at);
});

// ---------- unknown is never reported as infeasible ----------

test("unknown mold reference -> exit 2, NOT infeasible", () => {
  const dir = tmpdir();
  const input = path.join(dir, "u.jsonl");
  writeLines(input, [
    '{"type":"machine","id":"M1"}',
    '{"type":"mold","id":"F1","cycle":2}',
    '{"type":"order","id":"O1","mold":"F9","qty":1,"due":10,"person":"P1"}',
  ]);
  const r = run(["plan", "--input", input, "--state", path.join(dir, "st")]);
  assert.equal(r.code, 2);
  assert.equal(JSON.parse(r.stderr).code, "UNKNOWN_MOLD");
});

test("missing setup matrix entries default to 0 and stay feasible", () => {
  const dir = tmpdir();
  const lines = BASE.filter((l) => l.type !== "setup"); // no setup knowledge at all
  const input = path.join(dir, "nosetup.jsonl");
  writeLines(input, lines.map((l) => JSON.stringify(l)));
  const r = run(["plan", "--input", input, "--state", path.join(dir, "st")]);
  assert.equal(r.code, 0, r.stderr);
  assert.equal(JSON.parse(r.stdout).status, "ok");
});

// ---------- infeasible: exit 3 with minimal conflict set ----------

test("infeasible input -> exit 3 with minimal conflict set", () => {
  const dir = tmpdir();
  const input = path.join(dir, "inf.jsonl");
  writeLines(input, [
    '{"type":"machine","id":"M1"}',
    '{"type":"mold","id":"F1","cycle":1}',
    '{"type":"order","id":"A","mold":"F1","qty":10,"due":15,"person":"P1"}',
    '{"type":"order","id":"B","mold":"F1","qty":10,"due":15,"person":"P1"}',
    '{"type":"order","id":"C","mold":"F1","qty":1,"due":100,"person":"P1"}',
  ]);
  const r = run(["plan", "--input", input, "--state", path.join(dir, "st")]);
  assert.equal(r.code, 3);
  const err = JSON.parse(r.stderr);
  assert.equal(err.code, "INFEASIBLE");
  assert.deepEqual(err.conflicts, ["A", "B"]); // C plays no part in the conflict
  assert.ok(!fs.existsSync(path.join(dir, "st", "oplog.jsonl")), "nothing committed");
});

// ---------- acceptance 2: concurrent inserts, same mold ----------

test("concurrent same-mold inserts: causally earlier kept, certificate issued", () => {
  const dir = tmpdir();
  const state = initState(dir);

  // replica A inserts X1 with a concurrent clock {A:1}
  let r = run(["plan", "--state", state, "--node", "A", "--insert",
    '{"id":"X1","mold":"F1","qty":2,"due":300,"person":"P3"}', "--clock", '{"A":1}']);
  assert.equal(r.code, 0, r.stderr);
  assert.equal(JSON.parse(r.stdout).status, "ok");

  // replica B concurrently inserts X2 with the same mold (clock {B:1})
  r = run(["plan", "--state", state, "--node", "B", "--clock", '{"B":1}',
    "--insert", '{"id":"X2","mold":"F1","qty":2,"due":300,"person":"P3"}']);
  assert.equal(r.code, 0, r.stderr);
  const out = JSON.parse(r.stdout);
  assert.equal(out.status, "superseded");
  assert.deepEqual(out.conflicts, [{ winner: "op1", loser: "op2", mold: "F1" }]);

  // only the causally earlier order remains in the plan
  const scheduled = out.plan.map((p) => p.order);
  assert.ok(scheduled.includes("X1"));
  assert.ok(!scheduled.includes("X2"));

  // certificate generated and verifiable
  const certs = fs.readFileSync(path.join(state, "certs.jsonl"), "utf8").trim().split("\n").map(JSON.parse);
  assert.equal(certs.length, 1);
  assert.equal(certs[0].type, "conflict");
  assert.equal(certs[0].payload.winner.order, "X1");
  assert.equal(certs[0].payload.loser.order, "X2");

  r = run(["verify", "--state", state]);
  assert.equal(r.code, 0, r.stderr);
  assert.equal(JSON.parse(r.stdout).ok, true);

  // a causally LATER insert (sees both) does not conflict: both kept
  r = run(["plan", "--state", state, "--node", "A", "--insert",
    '{"id":"X3","mold":"F1","qty":1,"due":300,"person":"P3"}']);
  assert.equal(r.code, 0, r.stderr);
  const out3 = JSON.parse(r.stdout);
  assert.equal(out3.status, "ok");
  assert.deepEqual(out3.conflicts, []);
  const scheduled3 = out3.plan.map((p) => p.order);
  assert.ok(scheduled3.includes("X1") && scheduled3.includes("X3"));
});

// ---------- acceptance 3: undo to any point, replay consistency ----------

test("undo to midpoint and restore: replay consistent, certificate proves committed dues", () => {
  const dir = tmpdir();
  const lines = [
    { type: "machine", id: "M1" },
    { type: "machine", id: "M2" },
    { type: "mold", id: "F1", cycle: 2 },
    { type: "mold", id: "F2", cycle: 2 },
    // committed order: due == proc forces the 0-4 slot in every feasible plan
    { type: "order", id: "OC", mold: "F2", qty: 2, due: 4, person: "P1", committed: true },
  ];
  const state = initState(dir, lines);

  // three incremental inserts (all on the same machine/mold, after OC)
  for (const id of ["A1", "A2", "A3"]) {
    const r = run(["plan", "--state", state, "--insert",
      JSON.stringify({ id, mold: "F1", qty: 1, due: 100, person: "P2" })]);
    assert.equal(r.code, 0, r.stderr);
  }
  let r = run(["plan", "--state", state]);
  const fullPlan = JSON.parse(r.stdout);
  assert.equal(fullPlan.plan.length, 4);

  // undo to op1 (only base + first insert effective)
  r = run(["undo", "--state", state, "--to", "1"]);
  assert.equal(r.code, 0, r.stderr);
  const undone = JSON.parse(r.stdout);
  assert.equal(undone.point, 1);
  assert.equal(undone.plan.length, 2);
  assert.ok(undone.cert);

  // certificate chain + replay verify
  r = run(["verify", "--state", state]);
  assert.equal(r.code, 0, r.stderr);
  assert.equal(JSON.parse(r.stdout).ok, true);

  // undo certificate records the untouched committed due
  const certs = fs.readFileSync(path.join(state, "certs.jsonl"), "utf8").trim().split("\n").map(JSON.parse);
  const undoCert = certs.find((c) => c.type === "undo");
  assert.deepEqual(undoCert.payload.committed, [{ order: "OC", due: 4, end: 4 }]);

  // restore to the latest point: plan identical to before the undo (replay)
  r = run(["undo", "--state", state, "--to", "4"]);
  assert.equal(r.code, 0, r.stderr);
  const restored = JSON.parse(r.stdout);
  assert.deepEqual(restored.plan, fullPlan.plan);
  assert.deepEqual(restored.sequences, fullPlan.sequences);

  r = run(["verify", "--state", state]);
  assert.equal(r.code, 0, r.stderr);
});

test("undo that would change a committed due date is rejected (exit 4)", () => {
  const dir = tmpdir();
  // committed order OC shares machine M1 with later inserts; removing them
  // would reschedule OC -> undo must be refused.
  const lines = [
    { type: "machine", id: "M1" },
    { type: "mold", id: "F1", cycle: 2 },
    { type: "mold", id: "F2", cycle: 2 },
    { type: "setup", from: "F1", to: "F2", time: 3 },
    { type: "setup", from: "F2", to: "F1", time: 3 },
    { type: "order", id: "OC", mold: "F1", qty: 2, due: 100, person: "P1", committed: true },
  ];
  const state = initState(dir, lines);
  // B1 uses mold F2 and person P1: it delays OC on the shared person/mold? No --
  // it is inserted after OC, so OC keeps its slot; instead commit a second order.
  let r = run(["plan", "--state", state, "--insert",
    '{"id":"B1","mold":"F2","qty":3,"due":100,"person":"P1","committed":true}']);
  assert.equal(r.code, 0, r.stderr);
  r = run(["plan", "--state", state, "--insert",
    '{"id":"C1","mold":"F1","qty":2,"due":100,"person":"P1"}']);
  assert.equal(r.code, 0, r.stderr);
  // undo to before B1 existed: B1 (committed) would vanish -> rejected
  r = run(["undo", "--state", state, "--to", "0"]);
  assert.equal(r.code, 4);
  assert.equal(JSON.parse(r.stderr).code, "UNDO_BREAKS_COMMIT");
  // state untouched
  r = run(["verify", "--state", state]);
  assert.equal(r.code, 0, r.stderr);
});

// ---------- acceptance 4: crash after plan.tmp -> no half commit ----------

test("crash after writing plan.tmp: restart discards it, no half commit", () => {
  const dir = tmpdir();
  const state = initState(dir);
  const committed = fs.readFileSync(path.join(state, "plan.json"), "utf8");

  // simulate a crash: torn plan.tmp left behind, plan.json untouched
  fs.writeFileSync(path.join(state, "plan.tmp"), '{"version":1,"oplogLength":99,"gar');

  const r = run(["plan", "--state", state]);
  assert.equal(r.code, 0, r.stderr);
  assert.equal(JSON.parse(r.stdout).status, "ok");
  assert.ok(!fs.existsSync(path.join(state, "plan.tmp")), "tmp cleaned on recovery");
  assert.equal(fs.readFileSync(path.join(state, "plan.json"), "utf8"), committed);

  const v = run(["verify", "--state", state]);
  assert.equal(v.code, 0, v.stderr);
});

test("crash between oplog append and plan commit: plan regenerated on restart", () => {
  const dir = tmpdir();
  const state = initState(dir);
  // simulate crash: oplog has an extra committed insert but plan.json is stale
  const ops = fs.readFileSync(path.join(state, "oplog.jsonl"), "utf8").trim().split("\n").map(JSON.parse);
  const last = ops[ops.length - 1];
  const op = {
    seq: last.seq + 1,
    id: `op${last.seq + 1}`,
    node: "local",
    clock: { local: (last.clock.local ?? 0) + 1 },
    deps: [last.id],
    kind: "insert",
    order: { id: "O9", mold: "F1", qty: 1, due: 200, person: "P1", committed: false, proc: 2 },
  };
  fs.appendFileSync(path.join(state, "oplog.jsonl"), JSON.stringify(op) + "\n");

  const r = run(["plan", "--state", state]);
  assert.equal(r.code, 0, r.stderr);
  assert.ok(JSON.parse(r.stdout).plan.some((p) => p.order === "O9"), "recovered op replanned");
  const v = run(["verify", "--state", state]);
  assert.equal(v.code, 0, v.stderr);
});

// ---------- incremental insert infeasible -> exit 3, log untouched ----------

test("infeasible incremental insert -> exit 3, nothing committed", () => {
  const dir = tmpdir();
  const state = initState(dir);
  const before = fs.readFileSync(path.join(state, "oplog.jsonl"), "utf8");
  const r = run(["plan", "--state", state, "--insert",
    '{"id":"IMPOSSIBLE","mold":"F1","qty":500,"due":1,"person":"P1"}']);
  assert.equal(r.code, 3);
  const err = JSON.parse(r.stderr);
  assert.equal(err.code, "INFEASIBLE");
  assert.deepEqual(err.conflicts, ["IMPOSSIBLE"]);
  assert.equal(fs.readFileSync(path.join(state, "oplog.jsonl"), "utf8"), before);
});

test("duplicate order id and unknown mold on insert -> exit 2", () => {
  const dir = tmpdir();
  const state = initState(dir);
  let r = run(["plan", "--state", state, "--insert", '{"id":"O1","mold":"F1","qty":1,"due":50,"person":"P1"}']);
  assert.equal(r.code, 2);
  assert.equal(JSON.parse(r.stderr).code, "DUPLICATE");
  r = run(["plan", "--state", state, "--insert", '{"id":"O8","mold":"F9","qty":1,"due":50,"person":"P1"}']);
  assert.equal(r.code, 2);
  assert.equal(JSON.parse(r.stderr).code, "UNKNOWN_MOLD");
});
