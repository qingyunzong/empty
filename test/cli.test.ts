import test from "node:test";
import * as assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { run } from "../src/cli";

function capture(args: string[]): { code: number; lines: string[] } {
  const lines: string[] = [];
  const code = run(args, (l) => lines.push(l));
  return { code, lines };
}

test("plan command: certificate, conservation and finite-state check printed", () => {
  const { code, lines } = capture(["plan", "examples/basic.json"]);
  assert.equal(code, 0);
  const text = lines.join("\n");
  assert.ok(text.includes("== warehouse W1 =="));
  assert.ok(text.includes("== warehouse W2 =="));
  assert.ok(text.includes("optimal total cost: money=257"));
  assert.ok(text.includes("conservation: OK (12 days checked"));
  assert.ok((text.match(/finite-state check: OK/g) ?? []).length === 2);
  assert.ok(text.includes("total money (all warehouses): 335"));
});

test("verify command: DP and finite-state search match", () => {
  const { code, lines } = capture(["verify", "examples/basic.json"]);
  assert.equal(code, 0);
  const text = lines.join("\n");
  assert.ok(text.includes("=> MATCH"));
  assert.ok(text.includes("finite-state search agrees"));
});

test("crosscheck command: short-period enumeration agrees with DP", () => {
  const { code, lines } = capture(["crosscheck", "examples/short.json"]);
  assert.equal(code, 0);
  const text = lines.join("\n");
  assert.ok(text.includes("enumeration:"));
  assert.ok((text.match(/=> MATCH/g) ?? []).length === 2);
});

test("crosscheck on a large horizon skips enumeration gracefully", () => {
  const { code, lines } = capture(["crosscheck", "examples/basic.json"]);
  assert.equal(code, 0);
  assert.ok(lines.join("\n").includes("enumeration:   skipped"));
});

test("replan command: deviation-first, net difference, conservation", () => {
  const { code, lines } = capture(["replan", "examples/replan.json"]);
  assert.equal(code, 0);
  const text = lines.join("\n");
  assert.ok(text.includes("deviation from published quantities: 0 unit(s)"));
  assert.ok(text.includes("net difference: n/a (baseline infeasible)"));
  assert.ok(text.includes("conservation: OK (10 days checked"));
  assert.ok(text.includes("finite-state check: OK"));
});

test("replan --json emits parseable JSON", () => {
  const { code, lines } = capture(["replan", "examples/replan.json", "--json"]);
  assert.equal(code, 0);
  const jsonLine = lines.find((l) => l.startsWith("{"));
  if (jsonLine === undefined) throw new Error("no JSON output");
  const parsed = JSON.parse(lines.slice(lines.indexOf(jsonLine)).join("\n"));
  assert.equal(parsed.warehouses[0].id, "W1");
  assert.equal(parsed.warehouses[0].deviation, 0);
});

test("end-to-end via node process", () => {
  let out: string;
  try {
    out = execFileSync("node", ["dist/src/cli.js", "plan", "examples/basic.json"], { encoding: "utf8" });
  } catch (e) {
    if (String(e).includes("EPERM")) return; // sandbox blocks child processes
    throw e;
  }
  assert.ok(out.includes("conservation: OK"));
  const out2 = execFileSync("node", ["dist/src/cli.js", "verify", "examples/basic.json"], { encoding: "utf8" });
  assert.ok(out2.includes("MATCH"));
});

test("bad input is rejected with exit code 2", () => {
  const { code, lines } = capture(["plan", "does-not-exist.json"]);
  assert.equal(code, 2);
  assert.ok(lines[0].startsWith("error:"));
});
