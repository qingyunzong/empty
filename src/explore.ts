import { ProgramDef, RunResult, Simulator, Snapshot, runProgram } from "./simulator";

export const MAX_EXPLORE_STEPS = 20;

export interface ExploreOptions {
  maxSteps?: number;
  maxStates?: number;
  maxExamplesPerResult?: number;
}

export interface TerminalState {
  kind: "done" | "deadlock" | "cutoff";
  schedule: number[];
  snapshot: Snapshot;
}

export interface ResultSetEntry {
  key: string;
  shared: Record<string, number>;
  locks: Record<string, number | null>;
  examples: number[][];
}

export interface ExploreResult {
  maxSteps: number;
  statesVisited: number;
  truncated: boolean;
  terminals: TerminalState[];
  deadlocks: TerminalState[];
  cutoffs: TerminalState[];
  cutoffCount: number;
  resultSet: ResultSetEntry[];
}

const MAX_CUTOFF_EXAMPLES = 5;

export function explore(program: ProgramDef, options: ExploreOptions = {}): ExploreResult {
  const maxSteps = options.maxSteps ?? MAX_EXPLORE_STEPS;
  if (!Number.isInteger(maxSteps) || maxSteps < 1 || maxSteps > MAX_EXPLORE_STEPS) {
    throw new Error(`maxSteps must be an integer in [1, ${MAX_EXPLORE_STEPS}]`);
  }
  const maxStates = options.maxStates ?? 200_000;
  const maxExamples = options.maxExamplesPerResult ?? 3;

  const visited = new Set<string>();
  const terminals = new Map<string, TerminalState>();
  const deadlocks = new Map<string, TerminalState>();
  const cutoffs = new Map<string, TerminalState>();
  const results = new Map<string, ResultSetEntry>();
  let truncated = false;
  let cutoffCount = 0;

  interface Node {
    sim: Simulator;
    schedule: number[];
  }
  const stack: Node[] = [{ sim: new Simulator(program), schedule: [] }];

  while (stack.length > 0) {
    const { sim, schedule } = stack.pop()!;
    const key = sim.stateKey();
    if (visited.has(key)) continue;
    visited.add(key);
    if (visited.size > maxStates) {
      truncated = true;
      break;
    }

    if (sim.allDone()) {
      const snapshot = sim.snapshot();
      terminals.set(key, { kind: "done", schedule, snapshot });
      const rkey = sim.resultKey();
      let entry = results.get(rkey);
      if (!entry) {
        entry = { key: rkey, shared: snapshot.shared, locks: snapshot.locks, examples: [] };
        results.set(rkey, entry);
      }
      if (entry.examples.length < maxExamples) entry.examples.push(schedule);
      continue;
    }
    if (sim.isDeadlocked()) {
      const terminal: TerminalState = { kind: "deadlock", schedule, snapshot: sim.snapshot() };
      terminals.set(key, terminal);
      deadlocks.set(key, terminal);
      continue;
    }
    if (sim.steps >= maxSteps) {
      cutoffCount++;
      if (cutoffs.size < MAX_CUTOFF_EXAMPLES) {
        cutoffs.set(key, { kind: "cutoff", schedule, snapshot: sim.snapshot() });
      }
      continue;
    }

    for (const tid of sim.runnableThreads()) {
      const next = sim.clone();
      next.step(tid);
      stack.push({ sim: next, schedule: [...schedule, tid] });
    }
  }

  return {
    maxSteps,
    statesVisited: visited.size,
    truncated,
    terminals: [...terminals.values()],
    deadlocks: [...deadlocks.values()],
    cutoffs: [...cutoffs.values()],
    cutoffCount,
    resultSet: [...results.values()],
  };
}

const SEQUENTIAL_STEP_LIMIT = 100_000;

export function sequentialSchedule(program: ProgramDef): number[] {
  const sim = new Simulator(program);
  const schedule: number[] = [];
  for (let tid = 0; tid < program.threads.length; tid++) {
    while (!sim.isDone(tid)) {
      schedule.push(tid);
      sim.step(tid);
      if (schedule.length > SEQUENTIAL_STEP_LIMIT) {
        throw new Error("sequential reference did not terminate (step limit exceeded)");
      }
    }
  }
  return schedule;
}

export function sequentialReference(program: ProgramDef): RunResult {
  return runProgram(program, sequentialSchedule(program));
}

export type CheckStatus = "pass" | "fail" | "skip";

export interface VerifyCheck {
  name: string;
  status: CheckStatus;
  detail: string;
}

export interface VerifyReport {
  ok: boolean;
  checks: VerifyCheck[];
}

export function verify(program: ProgramDef, result: ExploreResult): VerifyReport {
  const checks: VerifyCheck[] = [];

  const replayed = [...result.terminals, ...result.cutoffs];
  let replayFailures = 0;
  for (const terminal of replayed) {
    const replay = runProgram(program, terminal.schedule);
    if (JSON.stringify(replay.final) !== JSON.stringify(terminal.snapshot)) replayFailures++;
  }
  checks.push({
    name: "replay",
    status: replayFailures === 0 ? "pass" : "fail",
    detail: `${replayed.length - replayFailures}/${replayed.length} terminal schedules replay to the recorded state`,
  });

  const reference = sequentialReference(program);
  if (reference.outcome !== "done") {
    checks.push({
      name: "sequential-reference",
      status: "fail",
      detail: `sequential reference did not finish (outcome=${reference.outcome})`,
    });
  } else {
    const refKey = JSON.stringify([reference.final.shared, reference.final.locks]);
    const found = result.resultSet.some((entry) => entry.key === refKey);
    if (found) {
      checks.push({
        name: "sequential-reference",
        status: "pass",
        detail: `sequential result ${refKey} is a member of the explored result set`,
      });
    } else if (reference.final.steps > result.maxSteps || result.truncated || result.cutoffCount > 0) {
      checks.push({
        name: "sequential-reference",
        status: "skip",
        detail: `sequential run needs ${reference.final.steps} steps but exploration is bounded (maxSteps=${result.maxSteps})`,
      });
    } else {
      checks.push({
        name: "sequential-reference",
        status: "fail",
        detail: `sequential result ${refKey} is missing from the explored result set`,
      });
    }
  }

  const again = explore(program, { maxSteps: result.maxSteps });
  const keysOf = (r: ExploreResult) => r.resultSet.map((e) => e.key).sort();
  const sameResults = JSON.stringify(keysOf(result)) === JSON.stringify(keysOf(again));
  const sameDeadlocks = result.deadlocks.length === again.deadlocks.length;
  checks.push({
    name: "determinism",
    status: sameResults && sameDeadlocks ? "pass" : "fail",
    detail: sameResults && sameDeadlocks
      ? `re-exploration reproduces ${result.resultSet.length} result(s) and ${result.deadlocks.length} deadlock state(s)`
      : "re-exploration produced a different outcome set",
  });

  return { ok: checks.every((c) => c.status !== "fail"), checks };
}
