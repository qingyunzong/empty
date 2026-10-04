import { join } from "node:path";
import { check, CheckerReport } from "./checker.js";
import { Coordinator, Decision, Vote } from "./coordinator.js";
import { CrashFault, CrashInjector } from "./fault.js";
import { Participant } from "./participant.js";
import { Wal } from "./wal.js";

export interface ScenarioOptions {
  dir: string;
  txnId?: string;
  votes: Record<string, Vote>;
  /** Persistence points to crash at, in order; each fault fires once. */
  crashAt?: string[];
}

export interface ScenarioResult {
  decision: Decision;
  crashes: string[];
  checkpoints: string[];
  checker: CheckerReport;
  dir: string;
}

/**
 * Runs one 2PC transaction, optionally crashing at armed persistence
 * points. After every crash the simulator builds brand-new coordinator and
 * participant objects whose only input is the on-disk logs -- restart
 * follows the records and nothing else.
 */
export function runScenario(options: ScenarioOptions): ScenarioResult {
  const txnId = options.txnId ?? "txn-1";
  const injector = new CrashInjector(options.crashAt ?? []);
  const crashes: string[] = [];
  const coordinatorLog = join(options.dir, "coordinator.log");
  const participantLogs = Object.fromEntries(
    Object.keys(options.votes).map((id) => [id, join(options.dir, "participant-" + id + ".log")]),
  );

  for (;;) {
    const participants = Object.entries(options.votes).map(
      ([id, vote]) => new Participant(id, participantLogs[id], () => vote, injector),
    );
    const coordinator = new Coordinator(new Wal(coordinatorLog), injector);
    try {
      const decision = coordinator.run(txnId, participants);
      const checker = check({ coordinatorLog, participantLogs });
      return { decision, crashes, checkpoints: injector.visited, checker, dir: options.dir };
    } catch (err) {
      if (err instanceof CrashFault) {
        crashes.push(err.point);
        continue; // process restart: rebuild everything from disk
      }
      throw err;
    }
  }
}
