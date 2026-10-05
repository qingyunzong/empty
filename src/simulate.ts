/**
 * Independent schedule checker: replays a schedule tick by tick and
 * validates every constraint, producing the heat trajectory.
 */
import { Instance, ScheduleEntry, TickTrace } from "./model";

export interface SimResult {
  ok: boolean;
  errors: string[];
  makespan: number;
  trace: TickTrace[];
}

export function simulate(inst: Instance, schedule: ScheduleEntry[]): SimResult {
  const errors: string[] = [];
  const byId = new Map(inst.tasks.map((t, i) => [t.id, { t, i }]));
  const done = new Set<number>();

  // Build per-tick action map.
  const actionAt = new Map<number, string>();
  for (const e of schedule) {
    const rec = byId.get(e.taskId);
    if (!rec) {
      errors.push(`unknown task id: ${e.taskId}`);
      continue;
    }
    const { t, i } = rec;
    if (e.start < 1 || e.end < e.start) {
      errors.push(`task ${e.taskId}: invalid interval [${e.start}, ${e.end}]`);
      continue;
    }
    if (e.end - e.start + 1 !== t.duration) {
      errors.push(
        `task ${e.taskId}: interval length ${e.end - e.start + 1} != duration ${t.duration}`,
      );
    }
    if (e.end > t.deadline) {
      errors.push(`task ${e.taskId}: ends at ${e.end}, deadline ${t.deadline}`);
    }
    if (done.has(i)) errors.push(`task ${e.taskId}: scheduled twice`);
    done.add(i);
    for (let tick = e.start; tick <= e.end; tick++) {
      if (actionAt.has(tick)) {
        errors.push(`tick ${tick}: overlap between ${actionAt.get(tick)} and ${e.taskId}`);
      }
      actionAt.set(tick, e.taskId);
    }
  }
  for (let i = 0; i < inst.tasks.length; i++) {
    if (!done.has(i)) errors.push(`task ${inst.tasks[i]!.id}: never scheduled`);
  }

  const makespan = schedule.reduce((m, e) => Math.max(m, e.end), 0);
  if (makespan > inst.maxTicks) {
    errors.push(`makespan ${makespan} exceeds maxTicks ${inst.maxTicks}`);
  }

  const trace: TickTrace[] = [];
  let heat = 0;
  for (let tick = 1; tick <= makespan; tick++) {
    const a = actionAt.get(tick);
    if (a === undefined) {
      heat = Math.max(0, heat - inst.coolRate);
      trace.push({ tick, action: "idle", heatAfter: heat });
    } else {
      heat += byId.get(a)!.t.heat;
      trace.push({ tick, action: a, heatAfter: heat });
    }
    if (heat > inst.heatCap) {
      errors.push(`tick ${tick}: heat ${heat} exceeds cap ${inst.heatCap}`);
    }
  }

  return { ok: errors.length === 0, errors, makespan, trace };
}
