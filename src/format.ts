import { Certificate, SolveResult, StepInterval, VarSolution } from "./solver";
import { Verification } from "./verify";

export function describeCertificate(cert: Certificate): string {
  switch (cert.type) {
    case "constant-contradiction":
      return `constant contradiction in ${cert.constraint}: ${cert.detail}`;
    case "empty-interval":
      return `empty interval: lower bound ${cert.lower.value} (from ${cert.lower.source}) exceeds upper bound ${cert.upper.value} (from ${cert.upper.source})`;
    case "congruence-unsolvable":
      return `congruence ${cert.constraint} has no solution: ${cert.detail}`;
    case "crt-conflict":
      return `congruence ${cert.conflicting} conflicts with [${cert.accumulated.join(", ")}]: residues differ mod gcd ${cert.gcd}`;
    case "no-solution-in-interval":
      return `no x === ${cert.residue} (mod ${cert.modulus}) lies in [${cert.lo}, ${cert.hi}]`;
  }
}

function intervalValues(iv: StepInterval): bigint[] {
  const out: bigint[] = [];
  for (let v = iv.start; v <= iv.end; v += iv.step) out.push(v);
  return out;
}

export function formatInterval(iv: StepInterval): string {
  if (iv.start === iv.end) return `{${iv.start}}`;
  if (iv.step === 1n) return `[${iv.start} .. ${iv.end}]`;
  return `[${iv.start} .. ${iv.end}] step ${iv.step}`;
}

const MAX_LISTED = 10;

export function formatVarSolution(sol: VarSolution): string {
  const lines: string[] = [];
  if (sol.status === "unsat") {
    lines.push(`${sol.variable}: UNSAT`);
    lines.push(`  certificate: ${describeCertificate(sol.certificate!)}`);
    return lines.join("\n");
  }
  lines.push(
    `${sol.variable}: SAT, ${sol.solutionCount} solution${sol.solutionCount === 1n ? "" : "s"} in shrunk domain [${sol.bounds.lo}, ${sol.bounds.hi}]`
  );
  for (const iv of sol.intervals) {
    lines.push(`  ${formatInterval(iv)}`);
  }
  if (sol.solutionCount <= BigInt(MAX_LISTED)) {
    const values = sol.intervals.flatMap(intervalValues);
    lines.push(`  values: ${values.map(String).join(", ")}`);
  }
  return lines.join("\n");
}

export function formatVerification(v: Verification): string {
  const status = v.ok ? "OK" : "FAILED";
  let s = `  verification [${v.mode}]: ${status} — ${v.detail}`;
  for (const m of v.mismatches) s += `\n    mismatch: ${m}`;
  return s;
}

export function formatHuman(result: SolveResult, verifications: Verification[] | null): string {
  const parts: string[] = [];
  if (result.certificate) {
    parts.push(`UNSAT`);
    parts.push(`certificate: ${describeCertificate(result.certificate)}`);
    return parts.join("\n");
  }
  for (let i = 0; i < result.variables.length; i++) {
    parts.push(formatVarSolution(result.variables[i]!));
    if (verifications) parts.push(formatVerification(verifications[i]!));
  }
  parts.push(result.status === "sat" ? "status: SAT" : "status: UNSAT");
  return parts.join("\n");
}

function bigintReplacer(_key: string, value: unknown): unknown {
  return typeof value === "bigint" ? value.toString() : value;
}

export function formatJson(
  result: SolveResult,
  verifications: Verification[] | null
): string {
  return JSON.stringify({ ...result, verification: verifications }, bigintReplacer, 2);
}
