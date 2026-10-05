import { shortestPath } from "./graph";
import { checkFeasible, enumerateAll, maskCost } from "./solver";
import { NormalizedProblem } from "./types";
import { Report } from "./certify";

export interface VerifyResult {
  ok: boolean;
  checks: { name: string; ok: boolean; detail?: string }[];
}

/** independently re-verify a solution report against the problem */
export function verifyReport(p: NormalizedProblem, report: Report): VerifyResult {
  const checks: VerifyResult["checks"] = [];
  const push = (name: string, ok: boolean, detail?: string) => checks.push({ name, ok, ...(detail ? { detail } : {}) });

  if (report.status === "infeasible") {
    // confirm infeasibility independently by re-running full enumeration
    const en = enumerateAll(p);
    push("infeasibility-confirmed", en.bestMask === -1, en.bestMask === -1 ? undefined : "enumeration found a feasible set");
    const c = report.infeasibility?.undeletableCycle;
    if (c) {
      // confirm the claimed undeletable cycle really is a cycle of locked edges
      let valid = c.length >= 2 && c[0] === c[c.length - 1];
      if (valid) {
        for (let k = 0; k + 1 < c.length && valid; k++) {
          const e = p.edges.find((x) => x.from === c[k] && x.to === c[k + 1] && x.locked);
          if (!e) valid = false;
        }
      }
      push("undeletable-cycle-valid", valid);
    }
    return { ok: checks.every((x) => x.ok), checks };
  }

  const deleted = new Set((report.deletedEdges ?? []).map((d) => d.id));
  let mask = 0;
  let maskOk = true;
  for (let i = 0; i < p.edges.length; i++) {
    if (deleted.has(p.edges[i]!.id)) mask |= 1 << i;
  }
  if (deleted.size !== (report.deletedEdges ?? []).length) {
    maskOk = false;
    push("deleted-edges-unique", false);
  }
  for (const id of deleted) {
    if (!p.edges.some((e) => e.id === id)) {
      maskOk = false;
      push("deleted-edges-exist", false, `unknown edge ${id}`);
    }
  }
  if (maskOk) push("deleted-edges-parse", true);

  // 1. feasibility of the deletion set (locked, closure, budget, acyclic, reachability)
  const f = checkFeasible(p, mask);
  push("deletion-set-feasible", f.ok, f.ok ? undefined : f.reason);

  // 2. reported cost matches
  const cost = maskCost(p, mask);
  push("cost-matches", report.cost === cost, `report=${report.cost} actual=${cost}`);

  // 3. topological order is a valid linearization of the remaining graph
  const order = report.topologicalOrder ?? [];
  const keep = (i: number) => (mask & (1 << i)) === 0;
  let topoOk = order.length === p.nodes.length && new Set(order).size === p.nodes.length;
  if (topoOk) {
    const pos = new Map(order.map((n, i) => [n, i]));
    for (let i = 0; i < p.edges.length && topoOk; i++) {
      if (!keep(i)) continue;
      const e = p.edges[i]!;
      if (!(pos.get(e.from)! < pos.get(e.to)!)) topoOk = false;
    }
    // every graph node appears
    for (const n of p.nodes) if (!pos.has(n)) topoOk = false;
  }
  push("topological-order-valid", topoOk);

  // 4. every required reachability relation has a valid path certificate
  const certs = report.reachabilityCertificates ?? [];
  for (const r of p.reachability) {
    const cert = certs.find((c) => c.from === r.from && c.to === r.to);
    if (!cert) {
      push(`certificate ${r.from}->${r.to}`, false, "missing");
      continue;
    }
    let ok = cert.nodes.length >= 1 && cert.nodes[0] === r.from && cert.nodes[cert.nodes.length - 1] === r.to;
    if (ok && r.from !== r.to) {
      for (let k = 0; k + 1 < cert.nodes.length && ok; k++) {
        const ei = p.edges.findIndex(
          (e, i) => keep(i) && e.from === cert.nodes[k] && e.to === cert.nodes[k + 1]
        );
        if (ei === -1) ok = false;
      }
    }
    push(`certificate ${r.from}->${r.to}`, ok);
    // cross-check with an independent BFS
    const sp = shortestPath(p, keep, r.from, r.to);
    push(`reachability ${r.from}->${r.to}`, sp !== null);
  }

  // 5. optimality: re-run exhaustive enumeration and compare
  const en = enumerateAll(p);
  push(
    "optimal",
    en.bestMask !== -1 && en.bestCost === cost,
    `enumeration best=${en.bestMask === -1 ? "none" : en.bestCost} report=${cost}`
  );

  // 6. per-deleted-edge witness cycles, when claimed
  for (const d of report.deletedEdges ?? []) {
    if (!d.witnessCycle) continue;
    const cyc = d.witnessCycle;
    // first hop is the deleted edge itself; every later hop must exist as a kept edge
    let ok =
      cyc.length >= 2 &&
      cyc[0] === d.from &&
      cyc[cyc.length - 1] === d.from &&
      (cyc.length === 2 ? d.from === d.to : cyc[1] === d.to);
    for (let k = 1; k + 1 < cyc.length && ok; k++) {
      const ei = p.edges.findIndex((e, i) => keep(i) && e.from === cyc[k] && e.to === cyc[k + 1]);
      if (ei === -1) ok = false;
    }
    push(`witness-cycle ${d.id}`, ok);
  }

  return { ok: checks.every((x) => x.ok), checks };
}
