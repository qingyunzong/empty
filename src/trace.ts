import { Machine, simulate } from "./fsm.js";
import { Judgment } from "./reduce.js";

export interface TraceHeader {
  kind: "header";
  version: 1;
  machine: Machine;
  original: string[];
}

export interface TraceFinal {
  kind: "final";
  reduced: string[];
  oneMinimal: boolean;
  judgmentCount: number;
  error?: string;
}

export type TraceLine = TraceHeader | Judgment | TraceFinal;

export function headerLine(machine: Machine, original: string[]): string {
  const header: TraceHeader = { kind: "header", version: 1, machine, original: [...original] };
  return JSON.stringify(header);
}

export function judgmentLine(j: Judgment): string {
  return JSON.stringify(j);
}

export function finalLine(final: TraceFinal): string {
  return JSON.stringify(final);
}

export interface ReplayReport {
  ok: boolean;
  judgmentCount: number;
  mismatches: string[];
  reduced: string[] | null;
  oneMinimal: boolean;
}

/**
 * Re-execute every judgment recorded in a trace against the embedded machine
 * and confirm the verdicts reproduce exactly. Also independently re-checks
 * that the final reduced sequence fails and is 1-minimal.
 */
export function replayTrace(traceText: string): ReplayReport {
  const lines = traceText.split("\n").filter((l) => l.trim().length > 0);
  const mismatches: string[] = [];
  let machine: Machine | null = null;
  let judgmentCount = 0;
  let reduced: string[] | null = null;

  for (const line of lines) {
    const entry = JSON.parse(line) as TraceLine;
    if (entry.kind === "header") {
      machine = entry.machine;
    } else if (entry.kind === "judge") {
      if (!machine) {
        mismatches.push("judge entry before header");
        continue;
      }
      judgmentCount++;
      const actual = simulate(machine, entry.candidate).verdict;
      if (actual !== entry.verdict) {
        mismatches.push(
          `step ${entry.step}: recorded verdict "${entry.verdict}" but replay gives "${actual}"`,
        );
      }
    } else if (entry.kind === "final") {
      reduced = entry.reduced;
    }
  }

  let oneMinimal = false;
  if (machine && reduced) {
    if (simulate(machine, reduced).verdict !== "fail") {
      mismatches.push("final reduced sequence does not fail on replay");
    } else {
      oneMinimal = true;
      for (let i = 0; i < reduced.length; i++) {
        const candidate = [...reduced.slice(0, i), ...reduced.slice(i + 1)];
        if (simulate(machine, candidate).verdict === "fail") {
          oneMinimal = false;
          mismatches.push(`reduced sequence is not 1-minimal: deleting index ${i} still fails`);
        }
      }
    }
  }

  return { ok: mismatches.length === 0, judgmentCount, mismatches, reduced, oneMinimal };
}
