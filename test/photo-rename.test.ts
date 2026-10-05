import { test } from "node:test";
import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { runCli } from "../src/cli.js";
import { applyMapping, recover, undo, verify } from "../src/ops.js";
import { buildPlan, PreflightError } from "../src/plan.js";
import { RecoveryError } from "../src/execute.js";
import { readJournal } from "../src/journal.js";
import { MappingFile, PlanStep } from "../src/types.js";

function makeDir(files: Record<string, string>): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "photo-rename-test-"));
  for (const [name, content] of Object.entries(files)) {
    fs.writeFileSync(path.join(dir, name), content);
  }
  return dir;
}

function listing(dir: string): string[] {
  return fs.readdirSync(dir).filter((n) => !n.startsWith(".photo-rename")).sort();
}

function content(dir: string, name: string): string {
  return fs.readFileSync(path.join(dir, name), "utf8");
}

test("simple batch rename applies and verifies", () => {
  const dir = makeDir({ "a.jpg": "A", "b.jpg": "B" });
  const mapping: MappingFile = { renames: [{ from: "a.jpg", to: "x.jpg" }, { from: "b.jpg", to: "y.jpg" }] };
  const result = applyMapping(dir, mapping, false);
  assert.equal(result.applied, 2);
  assert.deepEqual(listing(dir), ["x.jpg", "y.jpg"]);
  assert.equal(content(dir, "x.jpg"), "A");
  assert.deepEqual(verify(dir, mapping, false), []);
});

test("cyclic swap is executed via temporary names", () => {
  const dir = makeDir({ "a.jpg": "A", "b.jpg": "B", "c.jpg": "C" });
  const mapping: MappingFile = {
    renames: [
      { from: "a.jpg", to: "b.jpg" },
      { from: "b.jpg", to: "c.jpg" },
      { from: "c.jpg", to: "a.jpg" },
    ],
  };
  const plan = buildPlan(dir, mapping, false);
  assert.equal(plan.steps.length, 4); // 1 temp move + 3 real moves
  assert.ok(plan.steps.some((s: PlanStep) => s.temp));
  applyMapping(dir, mapping, false);
  assert.deepEqual(listing(dir), ["a.jpg", "b.jpg", "c.jpg"]);
  assert.equal(content(dir, "a.jpg"), "C");
  assert.equal(content(dir, "b.jpg"), "A");
  assert.equal(content(dir, "c.jpg"), "B");
  assert.deepEqual(verify(dir, mapping, false), []);
});

test("case-folded duplicate targets reject the whole batch", () => {
  const dir = makeDir({ "x.jpg": "X", "y.jpg": "Y" });
  const mapping: MappingFile = {
    caseFold: true,
    renames: [{ from: "x.jpg", to: "same.jpg" }, { from: "y.jpg", to: "SAME.JPG" }],
  };
  assert.throws(() => applyMapping(dir, mapping, true), PreflightError);
  assert.deepEqual(listing(dir), ["x.jpg", "y.jpg"]); // untouched
});

test("same targets are allowed without case folding", () => {
  const dir = makeDir({ "x.jpg": "X", "y.jpg": "Y" });
  const mapping: MappingFile = {
    renames: [{ from: "x.jpg", to: "same.jpg" }, { from: "y.jpg", to: "SAME.JPG" }],
  };
  applyMapping(dir, mapping, false);
  assert.deepEqual(listing(dir), ["SAME.JPG", "same.jpg"]);
});

test("target occupied by an unknown file rejects the whole batch", () => {
  const dir = makeDir({ "a.jpg": "A", "b.jpg": "B", "taken.jpg": "T" });
  const mapping: MappingFile = {
    renames: [{ from: "a.jpg", to: "x.jpg" }, { from: "b.jpg", to: "taken.jpg" }],
  };
  assert.throws(() => applyMapping(dir, mapping, false), /collides with existing file/);
  assert.deepEqual(listing(dir), ["a.jpg", "b.jpg", "taken.jpg"]); // nothing moved
});

test("missing source rejects the batch", () => {
  const dir = makeDir({ "a.jpg": "A" });
  const mapping: MappingFile = { renames: [{ from: "ghost.jpg", to: "x.jpg" }] };
  assert.throws(() => applyMapping(dir, mapping, false), /source not found/);
  assert.deepEqual(listing(dir), ["a.jpg"]);
});

test("interruption mid-batch recovers, and recovery is idempotent (run twice)", () => {
  const dir = makeDir({ "a.jpg": "A", "b.jpg": "B", "c.jpg": "C" });
  const mapping: MappingFile = {
    renames: [
      { from: "a.jpg", to: "b.jpg" },
      { from: "b.jpg", to: "c.jpg" },
      { from: "c.jpg", to: "d.jpg" },
    ],
  };
  // crash right before step 2 of 3
  assert.throws(() =>
    applyMapping(dir, mapping, false, {
      beforeStep: (i) => {
        if (i === 2) throw new Error("simulated crash");
      },
    })
  );
  assert.equal(readJournal(dir).completedSteps.size, 2);

  const first = recover(dir);
  assert.equal(first.status, "recovered");
  assert.deepEqual(listing(dir), ["b.jpg", "c.jpg", "d.jpg"]);
  assert.deepEqual(verify(dir, mapping, false), []);

  const second = recover(dir); // second recovery: no-op, state unchanged
  assert.equal(second.status, "already-complete");
  assert.deepEqual(listing(dir), ["b.jpg", "c.jpg", "d.jpg"]);
  assert.deepEqual(verify(dir, mapping, false), []);
});

test("step applied but journal write lost is reconciled, not redone", () => {
  const dir = makeDir({ "a.jpg": "A", "b.jpg": "B" });
  const mapping: MappingFile = { renames: [{ from: "a.jpg", to: "x.jpg" }, { from: "b.jpg", to: "y.jpg" }] };
  let captured: PlanStep[] = [];
  assert.throws(() =>
    applyMapping(dir, mapping, false, {
      beforeStep: (i, step) => {
        captured.push(step);
        if (i === 1) {
          // simulate crash between the rename and the journal write:
          fs.renameSync(path.join(dir, step.from), path.join(dir, step.to));
          throw new Error("simulated crash after rename");
        }
      },
    })
  );
  const result = recover(dir);
  assert.equal(result.status, "recovered");
  assert.equal(result.recovered, 1); // reconciled, not re-applied
  assert.deepEqual(listing(dir), ["x.jpg", "y.jpg"]);
  assert.deepEqual(verify(dir, mapping, false), []);
});

test("recovery refuses to overwrite an unknown file", () => {
  const dir = makeDir({ "a.jpg": "A", "b.jpg": "B" });
  const mapping: MappingFile = { renames: [{ from: "a.jpg", to: "x.jpg" }, { from: "b.jpg", to: "y.jpg" }] };
  let pendingTarget = "";
  assert.throws(() =>
    applyMapping(dir, mapping, false, {
      beforeStep: (i, step) => {
        if (i === 1) {
          pendingTarget = step.to;
          throw new Error("simulated crash");
        }
      },
    })
  );
  fs.writeFileSync(path.join(dir, pendingTarget), "UNKNOWN");
  assert.throws(() => recover(dir), RecoveryError);
  assert.equal(content(dir, pendingTarget), "UNKNOWN"); // not overwritten
  assert.equal(content(dir, "b.jpg"), "B"); // source intact
});

test("inverse plan restores the original names (including cycles)", () => {
  const dir = makeDir({ "a.jpg": "A", "b.jpg": "B", "c.jpg": "C" });
  const mapping: MappingFile = {
    renames: [
      { from: "a.jpg", to: "b.jpg" },
      { from: "b.jpg", to: "c.jpg" },
      { from: "c.jpg", to: "a.jpg" },
    ],
  };
  applyMapping(dir, mapping, false);
  const undone = undo(dir);
  assert.equal(undone.status, "undone");
  assert.deepEqual(listing(dir), ["a.jpg", "b.jpg", "c.jpg"]);
  assert.equal(content(dir, "a.jpg"), "A");
  assert.equal(content(dir, "b.jpg"), "B");
  assert.equal(content(dir, "c.jpg"), "C");

  const again = undo(dir); // inverse plan is journaled too: idempotent
  assert.equal(again.status, "already-undone");
  assert.deepEqual(listing(dir), ["a.jpg", "b.jpg", "c.jpg"]);
});

test("case-fold source resolution matches on-disk names per input rule", () => {
  const dir = makeDir({ "IMG_0001.JPG": "one" });
  const mapping: MappingFile = { caseFold: true, renames: [{ from: "img_0001.jpg", to: "photo-1.jpg" }] };
  applyMapping(dir, mapping, true);
  assert.deepEqual(listing(dir), ["photo-1.jpg"]);
  assert.equal(content(dir, "photo-1.jpg"), "one");
});

test("case-only rename works under case folding", () => {
  const dir = makeDir({ "A.jpg": "A" });
  const mapping: MappingFile = { caseFold: true, renames: [{ from: "A.jpg", to: "a.jpg" }] };
  applyMapping(dir, mapping, true);
  assert.deepEqual(listing(dir), ["a.jpg"]);
});

test("CLI: plan, apply, verify end to end", () => {
  const dir = makeDir({ "a.jpg": "A", "b.jpg": "B" });
  const mappingPath = path.join(dir, "mapping.json");
  fs.writeFileSync(
    mappingPath,
    JSON.stringify({ renames: [{ from: "a.jpg", to: "b.jpg" }, { from: "b.jpg", to: "a.jpg" }] })
  );
  assert.equal(runCli(["plan", mappingPath, "--dir", dir], dir), 0);
  assert.equal(runCli(["apply", mappingPath, "--dir", dir], dir), 0);
  assert.equal(runCli(["verify", mappingPath, "--dir", dir], dir), 0);
  assert.equal(content(dir, "a.jpg"), "B");
  assert.equal(content(dir, "b.jpg"), "A");
  assert.equal(runCli(["undo", "--dir", dir], dir), 0);
  assert.equal(content(dir, "a.jpg"), "A");
  assert.equal(content(dir, "b.jpg"), "B");
});

