/** CLI: read a plan request JSON, emit a coverage + download/decode certificate. */

import { readFileSync, writeFileSync } from "node:fs";
import { parseInput } from "./model";
import { buildPlan, type Certificate } from "./plan";

const USAGE =
  "usage: sync-plan <input.json> [-o certificate.json] [--no-verify]\n" +
  "\n" +
  "input.json: {\n" +
  '  "existing": [[start, end], ...],        // intervals the receiver already has\n' +
  '  "packages": [{ "id": "p1", "cover": [l, r], "bytes": B, "dict": D, "deps": ["p0"] }],\n' +
  '  "maxPackages": 20,                       // optional, default 20\n' +
  '  "memoryLimit": 1048576                   // optional\n' +
  "}\n";

export interface CliResult {
  summary: string;
  certificate: Certificate;
  exitCode: number;
  certificatePath: string | null;
}

export function summarize(cert: Certificate): string {
  const lines: string[] = [];
  const c = cert.cover;
  lines.push(`gaps: ${c.gaps.map(([a, b]) => `[${a},${b}]`).join(" ") || "(none)"}`);
  if (!c.feasible) {
    lines.push(`cover: INFEASIBLE - ${c.reason ?? "unknown reason"}`);
    return lines.join("\n");
  }
  lines.push(
    `cover: ${c.selectedBundles.length} bundle(s), ${c.packageCount} package(s), ` +
    `${c.totalBytes} bytes (limit ${c.maxPackages})`,
  );
  lines.push(`  bundles: ${c.selectedBundles.join(", ")}`);
  if (cert.dependencyClosure.addedBundles.length > 0) {
    lines.push(`  dependency closure added: ${cert.dependencyClosure.addedBundles.join(", ")}`);
  }
  const s = cert.schedule!;
  lines.push(`schedule order: ${s.order.join(" -> ")}`);
  for (const st of s.steps) {
    lines.push(
      `  ${st.bundle}: start=${st.memStart} +download=${st.memAfterDownload} ` +
      `peak=${st.memPeak} decoded=${st.memAfterDecode} released=${st.memAfterRelease}` +
      (st.released.length > 0 ? ` (freed: ${st.released.join(", ")})` : ""),
    );
  }
  lines.push(
    `memory: peak=${s.peakMemory}  bounds=[${s.lowerBound}, ${s.upperBound}]` +
    (s.memoryLimit !== null ? `  limit=${s.memoryLimit}  ${s.withinLimit ? "OK" : "EXCEEDED"}` : ""),
  );
  const v = cert.verification;
  if (v.coverBruteForce) {
    lines.push(
      `verify cover: brute force ${v.coverBruteForce.subsetsChecked} subsets, ` +
      `optimum ${v.coverBruteForce.totalBytes} -> ${v.coverBruteForce.matchesDP ? "MATCHES DP" : "MISMATCH!"}`,
    );
  }
  if (v.scheduleExhaustive) {
    lines.push(
      `verify schedule: exhaustive min peak ${v.scheduleExhaustive.minPeak} -> ` +
      `${v.scheduleExhaustive.matchesDP ? "MATCHES DP" : "MISMATCH!"}`,
    );
  }
  return lines.join("\n");
}

/** Pure-ish entry point (file I/O only for input/certificate); used by the CLI and tests. */
export function execute(args: string[]): CliResult {
  let inputPath: string | null = null;
  let outPath: string | null = null;
  let verify = true;
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    if (a === "-o") {
      i++;
      if (i >= args.length) throw new Error("usage");
      outPath = args[i]!;
    } else if (a === "--no-verify") verify = false;
    else if (a.startsWith("-")) throw new Error("usage");
    else if (inputPath === null) inputPath = a;
    else throw new Error("usage");
  }
  if (inputPath === null) throw new Error("usage");

  const raw: unknown = JSON.parse(readFileSync(inputPath, "utf8"));
  const input = parseInput(raw);
  const cert = buildPlan(input, verify);

  let certificatePath: string | null = null;
  if (outPath !== null) {
    writeFileSync(outPath, JSON.stringify(cert, null, 2) + "\n");
    certificatePath = outPath;
  }

  let exitCode = 0;
  if (!cert.cover.feasible) exitCode = 1;
  if (cert.schedule && cert.schedule.withinLimit === false) exitCode = 1;
  const v = cert.verification;
  if ((v.coverBruteForce && !v.coverBruteForce.matchesDP) || (v.scheduleExhaustive && !v.scheduleExhaustive.matchesDP)) {
    exitCode = 3;
  }
  return { summary: summarize(cert), certificate: cert, exitCode, certificatePath };
}

function main(): void {
  try {
    const { summary, exitCode, certificatePath } = execute(process.argv.slice(2));
    process.stdout.write(summary + "\n");
    if (certificatePath !== null) process.stdout.write(`certificate written to ${certificatePath}\n`);
    if (exitCode !== 0) process.exitCode = exitCode;
  } catch (err) {
    if ((err as Error).message === "usage") {
      process.stderr.write(USAGE);
      process.exitCode = 2;
    } else {
      process.stderr.write(`error: ${(err as Error).message}\n`);
      process.exitCode = 1;
    }
  }
}

if (require.main === module) main();
