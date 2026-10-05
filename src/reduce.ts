import { Machine, Verdict, simulate } from "./fsm.js";

export type JudgmentAction = "initial" | "block-delete" | "single-delete-check";

export interface Judgment {
  kind: "judge";
  step: number;
  action: JudgmentAction;
  base: string[];
  deleteStart: number | null;
  deleteLength: number | null;
  candidate: string[];
  verdict: Verdict;
  accepted: boolean;
}

export interface MinimizeResult {
  reduced: string[];
  judgments: Judgment[];
  oneMinimalChecks: Judgment[];
}

export class NotFailingError extends Error {
  readonly verdict: Verdict;
  constructor(verdict: Verdict) {
    super(`input sequence verdict is "${verdict}", expected "fail"`);
    this.name = "NotFailingError";
    this.verdict = verdict;
  }
}

/**
 * Deterministically shrink a failing event history.
 *
 * Strategy: try deleting contiguous blocks, starting at half the current
 * length and halving the block size whenever a full sweep finds no failing
 * deletion. A deletion is kept only if the shortened history still fails;
 * "invalid" histories (missing transitions) never count as failures.
 * The loop only exits after a full sweep with block size 1 finds nothing,
 * and a final verification pass re-checks every single-event deletion, so
 * the result is guaranteed 1-minimal.
 */
export function minimize(
  machine: Machine,
  events: string[],
  onJudgment?: (j: Judgment) => void,
): MinimizeResult {
  const judgments: Judgment[] = [];
  let step = 0;

  const judge = (
    action: JudgmentAction,
    base: string[],
    deleteStart: number | null,
    deleteLength: number | null,
    candidate: string[],
  ): { verdict: Verdict; entry: Judgment } => {
    const verdict = simulate(machine, candidate).verdict;
    const entry: Judgment = {
      kind: "judge",
      step: step++,
      action,
      base: [...base],
      deleteStart,
      deleteLength,
      candidate: [...candidate],
      verdict,
      accepted: false,
    };
    judgments.push(entry);
    onJudgment?.(entry);
    return { verdict, entry };
  };

  const initial = judge("initial", events, null, null, events);
  if (initial.verdict !== "fail") {
    throw new NotFailingError(initial.verdict);
  }

  let current = [...events];
  let size = Math.max(1, Math.ceil(current.length / 2));
  for (;;) {
    let progressed = false;
    for (let start = 0; start + size <= current.length; start++) {
      const candidate = [...current.slice(0, start), ...current.slice(start + size)];
      const { verdict, entry } = judge("block-delete", current, start, size, candidate);
      if (verdict === "fail") {
        entry.accepted = true;
        current = candidate;
        size = Math.max(1, Math.ceil(current.length / 2));
        progressed = true;
        break;
      }
    }
    if (progressed) continue;
    if (size === 1) break;
    size = Math.max(1, Math.floor(size / 2));
  }

  const oneMinimalChecks: Judgment[] = [];
  for (let i = 0; i < current.length; i++) {
    const candidate = [...current.slice(0, i), ...current.slice(i + 1)];
    const { verdict, entry } = judge("single-delete-check", current, i, 1, candidate);
    oneMinimalChecks.push(entry);
    if (verdict === "fail") {
      throw new Error("internal error: reducer stopped at a non-1-minimal sequence");
    }
  }

  return { reduced: current, judgments, oneMinimalChecks };
}
