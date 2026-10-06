import { test } from "node:test";
import { deepStrictEqual, equal, ok, throws } from "node:assert/strict";
import { readdirSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { applyPlan, rollback } from "../src/commands.js";
import { RecoveryError } from "../src/executor.js";
import { loadJournal } from "../src/journal.js";
import { verifyJournal } from "../src/verify.js";
import { contents, names, plan, setupDir } from "./util.js";

const MAPPING = {
  caseFold: true,
  renames: [
    { from: "a.jpg", to: "b.jpg" },
    { from: "b.jpg", to: "c.jpg" },
    { from: "c.jpg", to: "d.jpg" },
  ],
};
const FILES = { "a.jpg": "1", "b.jpg": "2", "c.jpg": "3" };
const FINAL = { "b.jpg": "1", "c.jpg": "2", "d.jpg": "3" };

test("journal persists every step and survives interruption after a done step", () => {
  const dir = setupDir(FILES);
  plan(dir, MAPPING);
  let crashes = 0;
  throws(() =>
    applyPlan(dir, {
      afterStep: (step) => {
        if (step.index === 1 && crashes++ === 0) throw new Error("simulated crash");
      },
    }),
  );
  const interrupted = loadJournal(dir);
  if (!interrupted) throw new Error("journal missing after crash");
  equal(interrupted.steps.filter((s) => s.status === "done").length, 2);
  equal(interrupted.steps.filter((s) => s.status === "pending").length, 1);
  const result = applyPlan(dir);
  equal(result.skipped, 2);
  equal(result.executed, 1);
  deepStrictEqual(contents(dir), FINAL);
  ok(loadJournal(dir)?.steps.every((s) => s.status === "done"));
});

test("interruption after the doing marker re-executes the step", () => {
  const dir = setupDir(FILES);
  plan(dir, MAPPING);
  let crashes = 0;
  throws(() =>
    applyPlan(dir, {
      afterDoing: (step) => {
        if (step.index === 0 && crashes++ === 0) throw new Error("simulated crash");
      },
    }),
  );
  equal(loadJournal(dir)?.steps[0]?.status, "doing");
  deepStrictEqual(contents(dir), FILES);
  applyPlan(dir);
  deepStrictEqual(contents(dir), FINAL);
});

test("resume refuses to overwrite an unknown file and leaves it intact", () => {
  const dir = setupDir(FILES);
  plan(dir, MAPPING);
  let crashes = 0;
  throws(() =>
    applyPlan(dir, {
      afterStep: (step) => {
        if (step.index === 0 && crashes++ === 0) throw new Error("simulated crash");
      },
    }),
  );
  const blocked = loadJournal(dir)?.steps.find((s) => s.status === "pending");
  if (!blocked) throw new Error("expected a pending step");
  writeFileSync(blocked.to, "unknown");
  throws(() => applyPlan(dir), (err: Error) => err instanceof RecoveryError && /unknown file/.test(err.message));
  equal(contents(dir)[blocked.to.slice(dir.length + 1) ?? ""], "unknown");
  equal(loadJournal(dir)?.steps.find((s) => s.index === blocked.index)?.status, "pending");
  unlinkSync(blocked.to);
  applyPlan(dir);
  deepStrictEqual(contents(dir), FINAL);
});

test("cycle swap recovers from interruption through the temp name", () => {
  const dir = setupDir({ "a.jpg": "1", "b.jpg": "2" });
  const journal = plan(dir, {
    caseFold: true,
    renames: [
      { from: "a.jpg", to: "b.jpg" },
      { from: "b.jpg", to: "a.jpg" },
    ],
  });
  const tempIndex = journal.steps.findIndex((s) => s.kind === "temp");
  let crashes = 0;
  throws(() =>
    applyPlan(dir, {
      afterStep: (step) => {
        if (step.index === tempIndex && crashes++ === 0) throw new Error("simulated crash");
      },
    }),
  );
  applyPlan(dir);
  deepStrictEqual(contents(dir), { "a.jpg": "2", "b.jpg": "1" });
  ok(!names(dir).some((n) => n.includes(".photo-tmp-")));
});

test("verify passes on a completed journal and recovery-twice is checked", () => {
  const dir = setupDir(FILES);
  plan(dir, MAPPING);
  applyPlan(dir);
  const report = verifyJournal(dir);
  deepStrictEqual(report.problems, []);
  ok(report.ok);
  ok(report.checks.some((c) => c.startsWith("recovery twice:")));
  ok(report.checks.some((c) => c.startsWith("inverse plan:")));
});

test("verify passes on an interrupted journal and reports pending recovery actions", () => {
  const dir = setupDir(FILES);
  plan(dir, MAPPING);
  let crashes = 0;
  throws(() =>
    applyPlan(dir, {
      afterStep: (step) => {
        if (step.index === 0 && crashes++ === 0) throw new Error("simulated crash");
      },
    }),
  );
  const report = verifyJournal(dir);
  ok(report.ok);
  ok(report.checks.some((c) => /recovery action/.test(c)));
});

test("verify fails when the filesystem was tampered with", () => {
  const dir = setupDir(FILES);
  plan(dir, MAPPING);
  applyPlan(dir);
  unlinkSync(join(dir, "d.jpg"));
  const report = verifyJournal(dir);
  ok(!report.ok);
  ok(report.problems.some((p) => /disagrees|missing|mismatch/.test(p)));
});

test("rollback applies the inverse plan and restores the initial state", () => {
  const dir = setupDir(FILES);
  plan(dir, MAPPING);
  applyPlan(dir);
  deepStrictEqual(contents(dir), FINAL);
  const { journal } = rollback(dir);
  equal(journal.kind, "rollback");
  deepStrictEqual(contents(dir), FILES);
  ok(readdirSync(dir).some((n) => n.includes(".done.json")));
});

test("rollback of a cycle swap restores both files", () => {
  const dir = setupDir({ "a.jpg": "1", "b.jpg": "2" });
  plan(dir, {
    caseFold: true,
    renames: [
      { from: "a.jpg", to: "b.jpg" },
      { from: "b.jpg", to: "a.jpg" },
    ],
  });
  applyPlan(dir);
  rollback(dir);
  deepStrictEqual(contents(dir), { "a.jpg": "1", "b.jpg": "2" });
});

test("rollback refuses while the plan is unfinished", () => {
  const dir = setupDir(FILES);
  plan(dir, MAPPING);
  throws(() => rollback(dir), /not fully applied/);
});
