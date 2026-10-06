import { test } from "node:test";
import { deepStrictEqual, equal, ok, throws } from "node:assert/strict";
import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { applyPlan, createPlan } from "../src/commands.js";
import { PreflightError } from "../src/mapping.js";
import { loadJournal } from "../src/journal.js";
import { contents, names, plan, setupDir } from "./util.js";

test("simple batch rename applies all steps", () => {
  const dir = setupDir({ "a.jpg": "1", "b.jpg": "2", "c.jpg": "3" });
  const journal = plan(dir, {
    caseFold: true,
    renames: [
      { from: "a.jpg", to: "x.jpg" },
      { from: "b.jpg", to: "y.jpg" },
      { from: "c.jpg", to: "z.jpg" },
    ],
  });
  equal(journal.steps.length, 3);
  const result = applyPlan(dir);
  equal(result.executed, 3);
  deepStrictEqual(contents(dir), { "x.jpg": "1", "y.jpg": "2", "z.jpg": "3" });
  ok(loadJournal(dir)?.steps.every((s) => s.status === "done"));
});

test("chain renames run in dependency order", () => {
  const dir = setupDir({ "a.jpg": "1", "b.jpg": "2" });
  plan(dir, {
    caseFold: true,
    renames: [
      { from: "a.jpg", to: "b.jpg" },
      { from: "b.jpg", to: "c.jpg" },
    ],
  });
  applyPlan(dir);
  deepStrictEqual(contents(dir), { "b.jpg": "1", "c.jpg": "2" });
});

test("two-way swap uses a temporary name and leaves no temp files", () => {
  const dir = setupDir({ "a.jpg": "1", "b.jpg": "2" });
  const journal = plan(dir, {
    caseFold: true,
    renames: [
      { from: "a.jpg", to: "b.jpg" },
      { from: "b.jpg", to: "a.jpg" },
    ],
  });
  equal(journal.steps.filter((s) => s.kind === "temp").length, 1);
  applyPlan(dir);
  deepStrictEqual(contents(dir), { "a.jpg": "2", "b.jpg": "1" });
  ok(!names(dir).some((n) => n.includes(".photo-tmp-")));
});

test("three-way rotation resolves the cycle", () => {
  const dir = setupDir({ "a.jpg": "1", "b.jpg": "2", "c.jpg": "3" });
  plan(dir, {
    caseFold: true,
    renames: [
      { from: "a.jpg", to: "b.jpg" },
      { from: "b.jpg", to: "c.jpg" },
      { from: "c.jpg", to: "a.jpg" },
    ],
  });
  applyPlan(dir);
  deepStrictEqual(contents(dir), { "a.jpg": "3", "b.jpg": "1", "c.jpg": "2" });
});

test("case-only rename works with case folding enabled", () => {
  const dir = setupDir({ "photo.jpg": "1" });
  plan(dir, { caseFold: true, renames: [{ from: "photo.jpg", to: "PHOTO.jpg" }] });
  applyPlan(dir);
  deepStrictEqual(contents(dir), { "PHOTO.jpg": "1" });
});

test("case-fold duplicate sources reject the whole batch", () => {
  const dir = setupDir({ "a.jpg": "1", "A.JPG": "2", "keep.jpg": "3" });
  throws(
    () =>
      plan(dir, {
        caseFold: true,
        renames: [
          { from: "a.jpg", to: "x.jpg" },
          { from: "A.JPG", to: "y.jpg" },
          { from: "keep.jpg", to: "keep2.jpg" },
        ],
      }),
    (err: Error) => err instanceof PreflightError && /duplicate source/.test(err.message),
  );
  deepStrictEqual(contents(dir), { "a.jpg": "1", "A.JPG": "2", "keep.jpg": "3" });
  equal(loadJournal(dir), null);
});

test("case-fold duplicate targets reject the whole batch", () => {
  const dir = setupDir({ "a.jpg": "1", "b.jpg": "2" });
  throws(
    () =>
      plan(dir, {
        caseFold: true,
        renames: [
          { from: "a.jpg", to: "Out.jpg" },
          { from: "b.jpg", to: "out.jpg" },
        ],
      }),
    /duplicate target/,
  );
  deepStrictEqual(contents(dir), { "a.jpg": "1", "b.jpg": "2" });
});

test("caseFold=false compares names literally", () => {
  const dir = setupDir({ "a.jpg": "1", "b.jpg": "2" });
  plan(dir, {
    caseFold: false,
    renames: [
      { from: "a.jpg", to: "Out.jpg" },
      { from: "b.jpg", to: "out.jpg" },
    ],
  });
  applyPlan(dir);
  deepStrictEqual(contents(dir), { "Out.jpg": "1", "out.jpg": "2" });
});

test("target that already exists outside the batch is a conflict", () => {
  const dir = setupDir({ "a.jpg": "1", "stranger.jpg": "unknown" });
  throws(() => plan(dir, { caseFold: true, renames: [{ from: "a.jpg", to: "stranger.jpg" }] }), /already exists/);
  deepStrictEqual(contents(dir), { "a.jpg": "1", "stranger.jpg": "unknown" });
});

test("missing source is a conflict", () => {
  const dir = setupDir({ "a.jpg": "1" });
  throws(() => plan(dir, { caseFold: true, renames: [{ from: "ghost.jpg", to: "x.jpg" }] }), /source missing/);
});

test("no-op rename is a conflict", () => {
  const dir = setupDir({ "a.jpg": "1" });
  throws(() => plan(dir, { caseFold: true, renames: [{ from: "a.jpg", to: "a.jpg" }] }), /no-op/);
});

test("paths escaping the working directory are conflicts", () => {
  const dir = setupDir({ "a.jpg": "1" });
  throws(() => plan(dir, { caseFold: true, renames: [{ from: "a.jpg", to: "../x.jpg" }] }), /escapes/);
  throws(() => plan(dir, { caseFold: true, renames: [{ from: "/etc/passwd", to: "x.jpg" }] }), /escapes/);
});

test("mapping accepts object form for renames", () => {
  const dir = setupDir({ "a.jpg": "1" });
  const file = join(setupDir({}), "mapping.json");
  writeFileSync(file, JSON.stringify({ renames: { "a.jpg": "b.jpg" } }));
  createPlan(dir, file);
  applyPlan(dir);
  deepStrictEqual(contents(dir), { "b.jpg": "1" });
  ok(existsSync(join(dir, ".photo-organize.journal.json")));
});
