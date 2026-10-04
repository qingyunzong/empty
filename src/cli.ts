#!/usr/bin/env node
/**
 * rect-pack CLI
 *
 * Usage:
 *   node dist/src/cli.js solve <instance.json> [--verify|--no-verify] [--json] [--out cert.json]
 *   node dist/src/cli.js verify <instance.json>
 *
 * Instance JSON:
 * {
 *   "grid": { "width": 8, "height": 8, "forbidden": [[x, y], ...] },
 *   "items": [{ "id": "A", "w": 2, "h": 3, "profit": 10, "rotate": true }, ...]
 * }
 */
import { readFileSync, writeFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { Instance, Solution, solve, validateInstance } from "./solver.js";
import { renderGrid, verifyInstance } from "./verify.js";

const CELLS_AUTO_VERIFY = 36; // auto exhaustive check up to this many grid cells

export interface CliResult {
  code: number;
  out: string;
  err: string;
}

const USAGE =
  "usage: cli solve <instance.json> [--verify|--no-verify] [--json] [--out file]\n" +
  "       cli verify <instance.json>";

function certificateJson(inst: Instance, sol: Solution) {
  return {
    grid: { width: inst.grid.width, height: inst.grid.height, forbidden: inst.grid.forbidden ?? [] },
    profit: sol.profit,
    area: sol.area,
    placements: sol.placements.map((p) => ({
      id: p.id, x: p.x, y: p.y, w: p.w, h: p.h, rotated: p.rotated,
    })),
  };
}

/** In-process CLI entry: returns exit code and captured output. */
export function run(argv: string[]): CliResult {
  const out: string[] = [];
  const err: string[] = [];
  const fail = (code: number, msg: string): CliResult => {
    err.push(msg);
    return { code, out: out.join("\n"), err: err.join("\n") };
  };

  const [cmd, file, ...rest] = argv;
  if (!cmd || !file || (cmd !== "solve" && cmd !== "verify")) {
    return fail(2, USAGE);
  }
  const flag = (name: string) => rest.includes(name);
  const outIdx = rest.indexOf("--out");
  const outPath = outIdx >= 0 ? rest[outIdx + 1] : undefined;

  let inst: Instance;
  try {
    inst = JSON.parse(readFileSync(file, "utf8")) as Instance;
    validateInstance(inst);
  } catch (e) {
    return fail(2, `error: ${e instanceof Error ? e.message : String(e)}`);
  }

  const sol = solve(inst);
  const cells = inst.grid.width * inst.grid.height;
  const wantVerify = cmd === "verify" ||
    flag("--verify") || (!flag("--no-verify") && cells <= CELLS_AUTO_VERIFY);

  if (flag("--json")) {
    out.push(JSON.stringify(certificateJson(inst, sol), null, 2));
  } else {
    out.push(`grid ${inst.grid.width}x${inst.grid.height}  items ${inst.items.length}`);
    out.push(`optimal: profit=${sol.profit} area=${sol.area} placed=${sol.placements.length}/${inst.items.length}`);
    out.push(renderGrid(inst, sol));
    for (const p of sol.placements) {
      out.push(`  ${p.id}: (${p.x},${p.y}) ${p.w}x${p.h}${p.rotated ? " rotated" : ""}`);
    }
  }

  if (outPath) {
    writeFileSync(outPath, JSON.stringify(certificateJson(inst, sol), null, 2) + "\n");
    err.push(`certificate written to ${outPath}`);
  }

  if (wantVerify) {
    const v = verifyInstance(inst, sol);
    if (!v.ok) {
      return fail(1, `VERIFY FAIL: ${v.reason}`);
    }
    // keep stdout pure JSON in --json mode; verify status goes to stderr there
    const sink = flag("--json") ? err : out;
    sink.push(v.checked
      ? `verify: OK (exhaustive, ${v.nodes} nodes) profit=${v.bruteForce!.profit} area=${v.bruteForce!.area}`
      : `verify: skipped (${v.reason}); certificate structurally valid`);
  }

  return { code: 0, out: out.join("\n"), err: err.join("\n") };
}

const isMain = typeof process.argv[1] === "string" &&
  import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  const result = run(process.argv.slice(2));
  if (result.out) console.log(result.out);
  if (result.err) console.error(result.err);
  process.exit(result.code);
}
