import * as fs from "node:fs";
import * as path from "node:path";
import { PlanStep } from "./types.js";

/** Raised during execution/recovery when the on-disk state is unexpected. */
export class RecoveryError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RecoveryError";
  }
}

export interface StepHook {
  /** Called immediately before a step is applied; throwing simulates a crash. */
  beforeStep?: (index: number, step: PlanStep) => void;
}

export interface RunResult {
  applied: number;
  recovered: number;
  skipped: number;
}

/** Rename without ever overwriting: hard-link then unlink (atomic, fails if
 *  the destination exists), falling back to rename on filesystems without
 *  hard-link support. */
function renameNoOverwrite(src: string, dst: string): void {
  try {
    fs.linkSync(src, dst);
    fs.unlinkSync(src);
  } catch (err) {
    const code = (err as { code?: string }).code;
    if (code === "EEXIST") throw err;
    fs.renameSync(src, dst);
  }
}

/**
 * Apply the steps not yet marked complete. Each applied step is reported to
 * `markDone` (which persists it) before moving on, so the process may be
 * interrupted at any step and recovered later.
 *
 * Recovery reconciliation per pending step:
 *  - source gone, destination present: step was applied but its journal write
 *    was lost -> record as recovered, do not touch anything.
 *  - source gone, destination gone: abort, state is unexplainable.
 *  - destination occupied while source still present: an unknown file is in
 *    the way -> abort, never overwrite it.
 */
export function runSteps(
  dir: string,
  steps: PlanStep[],
  completed: Set<number>,
  markDone: (index: number, recovered: boolean) => void,
  hook?: StepHook
): RunResult {
  const result: RunResult = { applied: 0, recovered: 0, skipped: 0 };
  for (let i = 0; i < steps.length; i++) {
    if (completed.has(i)) {
      result.skipped++;
      continue;
    }
    const step = steps[i]!;
    hook?.beforeStep?.(i, step);
    const src = path.join(dir, step.from);
    const dst = path.join(dir, step.to);
    const srcExists = fs.existsSync(src);
    const dstExists = fs.existsSync(dst);
    if (!srcExists && dstExists) {
      markDone(i, true);
      result.recovered++;
      continue;
    }
    if (!srcExists && !dstExists) {
      throw new RecoveryError(
        `step ${i} ("${step.from}" -> "${step.to}"): source and destination both missing; manual inspection required`
      );
    }
    if (dstExists) {
      throw new RecoveryError(
        `step ${i} ("${step.from}" -> "${step.to}"): unknown file already occupies the destination; refusing to overwrite`
      );
    }
    renameNoOverwrite(src, dst);
    markDone(i, false);
    result.applied++;
  }
  return result;
}
