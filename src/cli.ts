import { readFileSync, writeFileSync } from "node:fs";
import { buildCertificate, verifyCertificate } from "./certificate.js";
import { parseProblem } from "./types.js";

const USAGE = `sync-plan — sync planning CLI

Usage:
  sync-plan plan <problem.json> [--enumerate] [--no-bruteforce] [--max-packages N] [--out FILE]
  sync-plan verify <problem.json> <certificate.json>

Commands:
  plan     Solve: pick a minimum-total-byte set of at most N packages (default
           20) covering the receiver's gaps, then produce a download/decode
           schedule whose peak staging memory is minimized. Prints a JSON
           certificate to stdout (or --out FILE).
  verify   Independently re-check a certificate against its problem; exits 0
           when valid.

Options:
  --enumerate       Cross-check the cover solver by enumerating all subsets.
  --no-bruteforce   Skip the exhaustive decode-order cross-check.
  --max-packages N  Override the problem's package budget.
`;

export interface CliIO {
  stdout(chunk: string): void;
  stderr(chunk: string): void;
}

class CliError extends Error {
  constructor(message: string, readonly code: number) {
    super(message);
  }
}

function loadProblem(path: string, maxPackagesOverride: number | null) {
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path, "utf8"));
  } catch (err) {
    throw new CliError(`cannot read/parse ${path}: ${(err as Error).message}`, 1);
  }
  try {
    const problem = parseProblem(raw);
    if (maxPackagesOverride !== null) problem.maxPackages = maxPackagesOverride;
    return problem;
  } catch (err) {
    throw new CliError(`invalid problem: ${(err as Error).message}`, 1);
  }
}

/** Run the CLI; returns the process exit code. */
export function run(argv: string[], io: CliIO): number {
  const [cmd, ...rest] = argv;
  if (!cmd || cmd === "-h" || cmd === "--help") {
    io.stdout(USAGE);
    return 0;
  }
  if (cmd === "plan") {
    const files: string[] = [];
    let enumerate = false;
    let bruteForce = true;
    let out: string | null = null;
    let maxPackages: number | null = null;
    for (let i = 0; i < rest.length; i++) {
      const arg = rest[i]!;
      if (arg === "--enumerate") enumerate = true;
      else if (arg === "--no-bruteforce") bruteForce = false;
      else if (arg === "--out") {
        const v = rest[++i];
        if (!v) throw new CliError("--out requires a path", 1);
        out = v;
      } else if (arg === "--max-packages") {
        const v = Number(rest[++i]);
        if (!Number.isInteger(v) || v < 0) throw new CliError("--max-packages requires a non-negative integer", 1);
        maxPackages = v;
      } else if (arg.startsWith("-")) throw new CliError(`unknown option ${arg}`, 1);
      else files.push(arg);
    }
    if (files.length !== 1) throw new CliError("plan requires exactly one problem.json", 1);
    const problem = loadProblem(files[0]!, maxPackages);
    const cert = buildCertificate(problem, { enumerate, bruteForce });
    const json = JSON.stringify(cert, null, 2) + "\n";
    if (out) writeFileSync(out, json);
    else io.stdout(json);

    const cov = cert.coverage;
    if (!cov.feasible) {
      io.stderr(`coverage infeasible: ${cov.reason}\n`);
      return 1;
    }
    io.stderr(`cover: ${cov.selected.length} package(s), ${cov.totalBytes} bytes for ${cov.gapBytes} gap bytes\n`);
    const sched = cert.schedule!;
    io.stderr(
      `schedule: peak ${sched.peak} bytes (bounds [${sched.lowerBound}, ${sched.upperBound}], limit ${sched.memoryLimit}), ` +
      `download total ${sched.totalDownloadBytes} bytes, exact=${sched.exact}\n`,
    );
    if (!sched.feasible) {
      io.stderr(`schedule infeasible: ${sched.reason}\n`);
      return 1;
    }
    return 0;
  }
  if (cmd === "verify") {
    const files = rest.filter((a) => !a.startsWith("-"));
    if (files.length !== 2) throw new CliError("verify requires <problem.json> <certificate.json>", 1);
    const problem = loadProblem(files[0]!, null);
    let certRaw: unknown;
    try {
      certRaw = JSON.parse(readFileSync(files[1]!, "utf8"));
    } catch (err) {
      throw new CliError(`cannot read/parse ${files[1]}: ${(err as Error).message}`, 1);
    }
    const errors = verifyCertificate(problem, certRaw as never);
    if (errors.length > 0) {
      for (const e of errors) io.stderr(`invalid: ${e}\n`);
      return 2;
    }
    io.stderr("certificate valid\n");
    return 0;
  }
  throw new CliError(`unknown command ${cmd}`, 1);
}

/** Entrypoint: run the CLI against process stdio and set the exit code. */
export function main(): void {
  const io: CliIO = {
    stdout: (s) => process.stdout.write(s),
    stderr: (s) => process.stderr.write(s),
  };
  try {
    process.exitCode = run(process.argv.slice(2), io);
  } catch (err) {
    if (err instanceof CliError) {
      process.stderr.write(`sync-plan: ${err.message}\n`);
      process.exitCode = err.code;
    } else {
      process.stderr.write(`sync-plan: ${(err as Error).message}\n`);
      process.exitCode = 1;
    }
  }
}

if (process.argv[1] && process.argv[1].endsWith("cli.js")) main();
