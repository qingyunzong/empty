import { ExitError, EXIT } from './errors.js';
import { buildEventIndex, normalizeEvents } from './events.js';
import {
  evaluateTask,
  findCounterexamples,
  validateGrants,
  validateTask,
} from './policy.js';

function toPlanRecord(task, d) {
  return {
    task: task.id,
    decision: 'allow',
    zone: d.zone,
    zoneKind: d.zoneKind,
    priority: task.priority ?? 0,
    permission: d.grant
      ? { grant: d.grant, level: d.level, path: d.inheritedFrom }
      : d.exception
        ? { override: 'life-rescue' }
        : { open: true },
    causalChain: d.causalChain ?? null,
    ...(d.tempPass ? { tempPass: d.tempPass } : {}),
    ...(d.exception ? { exception: d.exception } : {}),
  };
}

function toDenyRecord(task, d, idx, grants, events) {
  return {
    task: task.id,
    decision: 'deny',
    zone: d.zone,
    zoneKind: d.zoneKind,
    priority: task.priority ?? 0,
    reason: d.reason,
    detail: {
      unseenGrants: d.unseenGrants ?? [],
      inactiveGrants: d.inactiveGrants ?? [],
    },
    counterexamples: findCounterexamples(idx, grants, task, events),
  };
}

export function schedule(idx, grants, tasks) {
  validateGrants(idx, grants);
  for (const task of tasks) validateTask(task);
  for (const task of tasks) {
    if (
      (task.kind ?? 'normal') === 'rescue' &&
      Array.isArray(task.dualAuth) &&
      new Set(task.dualAuth).size !== task.dualAuth.length
    ) {
      throw new ExitError(
        EXIT.SAME_AUTH,
        `task ${task.id}: dual authorization requires two distinct people, got ${JSON.stringify(task.dualAuth)}`,
      );
    }
  }
  const events = buildEventIndex(normalizeEvents(grants, tasks));
  const sorted = [...tasks].sort(
    (a, b) => (b.priority ?? 0) - (a.priority ?? 0) || String(a.id).localeCompare(String(b.id)),
  );
  const plan = [];
  const deny = [];
  for (const task of sorted) {
    const d = evaluateTask(idx, grants, task, events);
    if (d.allowed) {
      plan.push(toPlanRecord(task, d));
      continue;
    }
    if ((task.kind ?? 'normal') === 'rescue' && d.zoneKind === 'restricted') {
      const auth = task.dualAuth;
      if (Array.isArray(auth) && auth.length === 2) {
        plan.push(
          toPlanRecord(task, {
            ...d,
            exception: {
              type: 'life-rescue-override',
              authorizers: auth,
              overriddenReason: d.reason,
            },
          }),
        );
        continue;
      }
      deny.push(toDenyRecord(task, { ...d, reason: `${d.reason}+rescue-dual-auth-missing` }, idx, grants, events));
      continue;
    }
    deny.push(toDenyRecord(task, d, idx, grants, events));
  }
  return { plan, deny };
}
