import { Network } from "./network.js";

export interface WaitEdge {
  /** station holding the blocked (service-complete) customer */
  from: string;
  /** station whose full queue the customer is waiting for */
  to: string;
  customerId: number;
}

export interface CircularWaitReport {
  /** the full wait-for graph */
  edges: WaitEdge[];
  /** one cycle of edges, if any (the evidence chain) */
  cycle: WaitEdge[];
  /** station ids involved in the cycle */
  stations: string[];
  /** true when every server of every station on the cycle is blocked */
  hardDeadlock: boolean;
  /** human-readable evidence, e.g. "A -[customer 1]-> B -[customer 2]-> A" */
  summary: string;
}

/**
 * Build the wait-for graph and look for a circular wait.
 *
 * An edge A -> B exists when a server of A holds a customer whose service is
 * complete but who cannot move because B's bounded queue is full. A cycle in
 * this graph is a circular wait; it is a hard deadlock when every server of
 * every station on the cycle is blocked (no station can drain its queue, so
 * the cycle can never resolve itself).
 */
export function detectCircularWait(net: Network): CircularWaitReport {
  const edges: WaitEdge[] = [];
  const counts = net.counts();
  const capacity = new Map(net.cfg.stations.map((s) => [s.id, s.queueCapacity]));

  for (const sc of net.cfg.stations) {
    const { slots } = net.stationState(sc.id);
    for (const c of slots) {
      if (c === null || c.remaining > 0) continue;
      const next = c.route[c.routeIndex + 1];
      if (next === undefined) continue;
      const queued = counts[next]?.queued ?? 0;
      if (queued >= (capacity.get(next) ?? 0)) {
        edges.push({ from: sc.id, to: next, customerId: c.id });
      }
    }
  }

  const adjacency = new Map<string, WaitEdge[]>();
  for (const e of edges) {
    const list = adjacency.get(e.from) ?? [];
    list.push(e);
    adjacency.set(e.from, list);
  }

  const cycle: WaitEdge[] = [];
  const mark = new Map<string, number>(); // 1 = on DFS stack, 2 = done
  const stack: WaitEdge[] = [];

  const dfs = (node: string): boolean => {
    mark.set(node, 1);
    for (const e of adjacency.get(node) ?? []) {
      const m = mark.get(e.to) ?? 0;
      if (m === 0) {
        stack.push(e);
        if (dfs(e.to)) return true;
        stack.pop();
      } else if (m === 1) {
        const idx = stack.findIndex((x) => x.from === e.to);
        cycle.push(...stack.slice(idx), e);
        return true;
      }
    }
    mark.set(node, 2);
    return false;
  };

  for (const e of edges) {
    if ((mark.get(e.from) ?? 0) === 0 && dfs(e.from)) break;
  }

  const stations = [...new Set(cycle.map((e) => e.from))];
  const hardDeadlock =
    cycle.length > 0 &&
    stations.every((id) => {
      const c = counts[id];
      return c !== undefined && c.inService > 0 && c.inService === c.blocked;
    });

  const summary =
    cycle.length === 0
      ? "no circular wait"
      : cycle.map((e) => `${e.from} -[customer ${e.customerId}]-> `).join("") +
        (cycle[0] as WaitEdge).from +
        (hardDeadlock
          ? "  (hard deadlock: every server on the cycle is blocked)"
          : "");

  return { edges, cycle, stations, hardDeadlock, summary };
}
