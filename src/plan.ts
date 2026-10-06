import { basename, dirname, extname, join } from "node:path";
import { makeFold, type PlanStep, type Rename } from "./model.js";

export interface BuildPlanInput {
  renames: Rename[];
  caseFold: boolean;
  journalId: string;
  existingNames: Set<string>;
}

function tempName(sourceAbs: string, journalId: string, n: number): string {
  const dir = dirname(sourceAbs);
  const stem = basename(sourceAbs, extname(sourceAbs));
  const ext = extname(sourceAbs);
  return join(dir, `.photo-tmp-${journalId.slice(0, 8)}-${n}-${stem}${ext}`);
}

export function buildPlan(input: BuildPlanInput): PlanStep[] {
  const fold = makeFold(input.caseFold);
  const reserved = new Set(input.existingNames);
  for (const r of input.renames) {
    reserved.add(fold(r.from));
    reserved.add(fold(r.to));
  }

  const steps: PlanStep[] = [];
  const push = (kind: PlanStep["kind"], from: string, to: string): void => {
    steps.push({ index: steps.length, kind, from, to, status: "pending" });
  };

  let tempCounter = 0;
  const freshTemp = (sourceAbs: string): string => {
    for (;;) {
      const candidate = tempName(sourceAbs, input.journalId, tempCounter++);
      if (!reserved.has(fold(candidate))) {
        reserved.add(fold(candidate));
        return candidate;
      }
    }
  };

  interface Open {
    from: string;
    to: string;
  }
  const remaining = new Map<string, Open>();
  for (const r of input.renames) remaining.set(fold(r.from), { from: r.from, to: r.to });

  while (remaining.size > 0) {
    let progressed = false;
    for (const [key, entry] of remaining) {
      const targetKey = fold(entry.to);
      if (!remaining.has(targetKey) || targetKey === key) {
        push("rename", entry.from, entry.to);
        remaining.delete(key);
        progressed = true;
        break;
      }
    }
    if (!progressed) {
      const first = remaining.entries().next().value as [string, Open];
      const [key, entry] = first;
      const tmp = freshTemp(entry.from);
      push("temp", entry.from, tmp);
      remaining.delete(key);
      remaining.set(fold(tmp), { from: tmp, to: entry.to });
    }
  }
  return steps;
}

export function inversePlan(steps: PlanStep[]): PlanStep[] {
  const reversed = [...steps].reverse();
  return reversed.map((s, i) => ({
    index: i,
    kind: s.kind,
    from: s.to,
    to: s.from,
    status: "pending" as const,
  }));
}
