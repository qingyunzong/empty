import { test } from "node:test";
import { equal, ok } from "node:assert/strict";
import { readFileSync } from "node:fs";
import { run } from "../src/cli.js";

function makeIo(files: Record<string, string>) {
  const out: string[] = [];
  const err: string[] = [];
  const io = {
    readInput(path: string): string {
      if (path === "-") {
        if (!("-" in files)) throw new Error("no stdin provided");
        return files["-"] as string;
      }
      if (path in files) return files[path] as string;
      return readFileSync(path, "utf8");
    },
    stdout(text: string): void {
      out.push(text);
    },
    stderr(text: string): void {
      err.push(text);
    },
  };
  return { io, out: () => out.join("\n"), err: () => err.join("\n") };
}

test("cli solves feasible example with evidence and verification", () => {
  const { io, out, err } = makeIo({});
  const code = run(["examples/feasible.json"], io);
  equal(code, 0, err());
  ok(out().includes("Status: OPTIMAL"));
  ok(out().includes("Total cost: 6"));
  ok(out().includes("allow-all-read"));
  ok(out().includes("deny-secret"));
  ok(out().includes("allow-alice-write"));
  ok(out().includes("Evidence per sample:"));
  ok(out().includes("[OK] sample s1"));
  ok(out().includes("[OK] sample s5"));
  ok(out().includes("conflict resolution: deny wins"));
  ok(out().includes("default deny"));
  ok(out().includes("exhaustive enumeration of 32 subsets"));
  ok(out().includes("AGREES"));
});

test("cli reports infeasible example with exit code 1", () => {
  const { io, out } = makeIo({});
  const code = run(["examples/infeasible.json"], io);
  equal(code, 1);
  ok(out().includes("Status: INFEASIBLE"));
  ok(out().includes("exhaustive enumeration"));
  ok(out().includes("no subset satisfies all samples"));
});

test("cli rejects more than 18 candidates with exit code 2", () => {
  const raw = {
    candidates: Array.from({ length: 19 }, (_, i) => ({
      id: `r${i}`,
      action: "allow",
      cost: 1,
    })),
    samples: [],
  };
  const { io, err } = makeIo({ "-": JSON.stringify(raw) });
  const code = run(["-"], io);
  equal(code, 2);
  ok(err().includes("at most 18"));
});

test("cli reads from stdin and emits JSON with --json", () => {
  const raw = {
    candidates: [
      { id: "allow-all", action: "allow", cost: 3 },
      { id: "deny-secret", action: "deny", cost: 1,
        match: { resource: "secret" } },
    ],
    samples: [
      { id: "s1", expect: "allow",
        request: { subject: "a", op: "read", resource: "doc" } },
      { id: "s2", expect: "deny",
        request: { subject: "a", op: "read", resource: "secret" } },
    ],
  };
  const { io, out } = makeIo({ "-": JSON.stringify(raw) });
  const code = run(["-", "--json"], io);
  equal(code, 0);
  const payload = JSON.parse(out());
  equal(payload.status, "optimal");
  equal(payload.totalCost, 4);
  equal(payload.selected.length, 2);
  equal(payload.evidence.length, 2);
  ok(payload.evidence.every((e: { ok: boolean }) => e.ok));
  equal(payload.verification.method, "exhaustive-enumeration");
  equal(payload.verification.subsetsExplored, 4);
  ok(payload.verification.agrees);
});

test("cli exits 2 on malformed JSON and missing file", () => {
  const bad = makeIo({ "-": "{not json" });
  equal(run(["-"], bad.io), 2);
  const missing = makeIo({});
  equal(run(["/nonexistent/input.json"], missing.io), 2);
});

test("cli exits 2 with no arguments and prints usage", () => {
  const { io, err } = makeIo({});
  const code = run([], io);
  equal(code, 2);
  ok(err().includes("Usage:"));
});

test("cli prints usage with --help and exits 0", () => {
  const { io, out } = makeIo({});
  const code = run(["--help"], io);
  equal(code, 0);
  ok(out().includes("Usage:"));
});
