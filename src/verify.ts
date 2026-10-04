import {
  buildDeliveryPlan,
  certificateDigest,
  compareIds,
  stableStringify,
  type DeliveryPlan,
  type EventSpec,
} from "./engine.js";

export interface EnumerationOptions {
  priorityValues?: number[];
  maxCancelSize?: number;
}

export interface EnumerationReport {
  nodeCount: number;
  dagCount: number;
  instances: number;
  failures: string[];
}

function popcount(x: number): number {
  let c = 0;
  while (x !== 0) {
    x &= x - 1;
    c++;
  }
  return c;
}

function expectedBlocked(n: number, deps: string[][], cancelled: ReadonlySet<string>): Set<string> {
  const dependents = new Map<string, string[]>();
  for (let j = 0; j < n; j++) {
    for (const d of deps[j] as string[]) {
      const list = dependents.get(d);
      if (list) list.push(`e${j}`);
      else dependents.set(d, [`e${j}`]);
    }
  }
  const blocked = new Set<string>();
  const queue = [...cancelled];
  while (queue.length > 0) {
    const cur = queue.pop() as string;
    for (const next of dependents.get(cur) ?? []) {
      if (!cancelled.has(next) && !blocked.has(next)) {
        blocked.add(next);
        queue.push(next);
      }
    }
  }
  return blocked;
}

function checkInstance(
  label: string,
  ids: string[],
  deps: string[][],
  prios: number[],
  cancelledIds: string[],
  events: EventSpec[],
  plan: DeliveryPlan,
  failures: string[],
): void {
  const fail = (msg: string): void => {
    if (failures.length < 50) failures.push(`${label}: ${msg}`);
  };
  const cancelled = new Set(cancelledIds);
  const n = ids.length;

  // 1. blocked set == reverse-reachable from cancelled
  const wantBlocked = expectedBlocked(n, deps, cancelled);
  const gotBlocked = new Set(plan.blocked);
  if (wantBlocked.size !== gotBlocked.size || [...wantBlocked].some((b) => !gotBlocked.has(b))) {
    fail(`blocked mismatch want=${[...wantBlocked].join(",")} got=${plan.blocked.join(",")}`);
  }

  // 2. delivered set == everything else, and greedy rule holds at every step
  const delivered = new Set<string>();
  const remaining = new Set(ids.filter((id) => !cancelled.has(id) && !wantBlocked.has(id)));
  if (plan.order.length !== remaining.size) {
    fail(`order length ${plan.order.length} != deliverable ${remaining.size}`);
  }
  for (let step = 0; step < plan.order.length; step++) {
    let best: string | null = null;
    for (const id of remaining) {
      const idx = ids.indexOf(id);
      if (!(deps[idx] as string[]).every((d) => delivered.has(d))) continue;
      if (
        best === null ||
        (prios[idx] as number) > (prios[ids.indexOf(best)] as number) ||
        ((prios[idx] as number) === (prios[ids.indexOf(best)] as number) && compareIds(id, best) < 0)
      ) {
        best = id;
      }
    }
    const got = plan.order[step] as string;
    if (best === null || got !== best) {
      fail(`step ${step}: greedy expects ${String(best)} but delivered ${got}`);
      break;
    }
    remaining.delete(best);
    delivered.add(best);
  }

  // 3. certificates: seq, deps, digest all consistent
  for (let i = 0; i < plan.certificates.length; i++) {
    const cert = plan.certificates[i] as (typeof plan.certificates)[number];
    if (cert.seq !== i + 1) fail(`cert ${cert.eventId} seq ${cert.seq} != ${i + 1}`);
    if (cert.eventId !== plan.order[i]) fail(`cert order mismatch at ${i}`);
    const idx = ids.indexOf(cert.eventId);
    if (stableStringify(cert.satisfiedDeps) !== stableStringify([...new Set(deps[idx] as string[])])) {
      fail(`cert ${cert.eventId} satisfiedDeps mismatch`);
    }
    const recomputed = certificateDigest({
      seq: cert.seq,
      eventId: cert.eventId,
      priority: cert.priority,
      satisfiedDeps: cert.satisfiedDeps,
      meta: cert.meta,
    });
    if (recomputed !== cert.digest) fail(`cert ${cert.eventId} digest mismatch`);
  }

  // 4. blocking chains: shape + causality links + cancelled root
  const depSets = deps.map((d) => new Set(d));
  for (const bc of plan.blockingChains) {
    if (bc.chain[0] !== bc.eventId) fail(`chain for ${bc.eventId} starts elsewhere`);
    const root = bc.chain[bc.chain.length - 1] as string;
    if (!cancelled.has(root)) fail(`chain for ${bc.eventId} root ${root} not cancelled`);
    if (bc.rootCancelledId !== root) fail(`chain for ${bc.eventId} root field mismatch`);
    for (let k = 0; k + 1 < bc.chain.length; k++) {
      const from = bc.chain[k] as string;
      const to = bc.chain[k + 1] as string;
      if (!(depSets[ids.indexOf(from)] as Set<string>).has(to)) {
        fail(`chain for ${bc.eventId}: ${from} does not depend on ${to}`);
      }
      if (k + 1 < bc.chain.length - 1 && !wantBlocked.has(to)) {
        fail(`chain for ${bc.eventId}: intermediate ${to} not blocked`);
      }
    }
  }
  if (plan.blockingChains.length !== wantBlocked.size) {
    fail(`blockingChains count ${plan.blockingChains.length} != blocked ${wantBlocked.size}`);
  }

  // 5. cancelled metadata preserved
  const specById = new Map(events.map((e) => [e.id, e]));
  for (const rec of plan.cancelled) {
    if (!cancelled.has(rec.eventId)) fail(`cancelled record ${rec.eventId} not in cancel set`);
    const spec = specById.get(rec.eventId);
    if (stableStringify(rec.meta) !== stableStringify(spec?.meta ?? {})) {
      fail(`cancelled ${rec.eventId} meta not preserved`);
    }
  }
  if (plan.cancelled.length !== cancelled.size) {
    fail(`cancelled record count ${plan.cancelled.length} != ${cancelled.size}`);
  }
}

export function enumerateAndCheck(n: number, opts: EnumerationOptions = {}): EnumerationReport {
  const priorityValues = opts.priorityValues ?? [0, 1];
  const maxCancelSize = opts.maxCancelSize ?? n;
  const ids = Array.from({ length: n }, (_, i) => `e${i}`);
  const pairs: Array<[number, number]> = [];
  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) pairs.push([i, j]);
  }
  const dagCount = 2 ** pairs.length;
  const prioCombos = priorityValues.length ** n;
  const failures: string[] = [];
  let instances = 0;

  for (let mask = 0; mask < dagCount; mask++) {
    const deps: string[][] = ids.map(() => []);
    for (let bit = 0; bit < pairs.length; bit++) {
      if (mask & (1 << bit)) {
        const [i, j] = pairs[bit] as [number, number];
        (deps[j] as string[]).push(ids[i] as string);
      }
    }
    for (let pc = 0; pc < prioCombos; pc++) {
      const prios: number[] = [];
      let rem = pc;
      for (let i = 0; i < n; i++) {
        prios.push(priorityValues[rem % priorityValues.length] as number);
        rem = Math.floor(rem / priorityValues.length);
      }
      for (let cmask = 0; cmask < 1 << n; cmask++) {
        if (popcount(cmask) > maxCancelSize) continue;
        instances++;
        const cancelledIds = ids.filter((_, i) => (cmask & (1 << i)) !== 0);
        const events: EventSpec[] = ids.map((id, i) => ({
          id,
          priority: prios[i] as number,
          deps: deps[i] as string[],
          meta: { dag: mask, node: i },
        }));
        let plan: DeliveryPlan;
        try {
          plan = buildDeliveryPlan(events, cancelledIds);
        } catch (err) {
          failures.push(`dag=${mask} prio=${pc} cancel=${cmask}: threw ${String(err)}`);
          continue;
        }
        checkInstance(
          `dag=${mask} prio=${pc} cancel=${cmask}`,
          ids,
          deps,
          prios,
          cancelledIds,
          events,
          plan,
          failures,
        );
      }
    }
  }
  return { nodeCount: n, dagCount, instances, failures };
}
