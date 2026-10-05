import { edgeCost, marginalCost } from "./graph";
import { Certificate, CertificateCheck, EdgeFlow, NetworkSpec } from "./types";

/**
 * Verify a primal-dual optimality certificate for an integral min-cost flow.
 *
 * Checks, given the flow assignment and node potentials π:
 *  1. capacity: 0 <= flow_e <= capacity_e on every edge;
 *  2. conservation: net outflow is `sent` at the source, -`sent` at the sink,
 *     and 0 everywhere else;
 *  3. cost: the reported total cost matches the piecewise fee function;
 *  4. reduced costs: every residual arc has non-negative reduced cost, i.e.
 *       c(u,v) + π(u) - π(v) >= 0  for each remaining forward unit, and
 *      -c(u,v) + π(v) - π(u) >= 0  for each removable (backward) unit.
 *     Because marginal fees are non-decreasing per edge, it is sufficient to
 *     check the cheapest remaining forward unit and the cheapest backward
 *     unit on each edge; all other residual units are more expensive.
 */
export function verifyCertificate(
  spec: NetworkSpec,
  flows: EdgeFlow[],
  potentials: Record<string, number>,
  sent: number,
  reportedCost: number
): Certificate {
  const checks: CertificateCheck[] = [];

  const capacityOk = flows.every(
    (f) => Number.isInteger(f.flow) && f.flow >= 0 && f.flow <= spec.edges[f.edge]!.capacity
  );
  checks.push({
    name: "capacity",
    ok: capacityOk,
    detail: capacityOk ? undefined : "some edge flow is outside [0, capacity]",
  });

  const balance = new Map<string, number>();
  for (const f of flows) {
    balance.set(f.from, (balance.get(f.from) ?? 0) + f.flow);
    balance.set(f.to, (balance.get(f.to) ?? 0) - f.flow);
  }
  let conservationOk = true;
  let conservationDetail: string | undefined;
  for (const node of spec.nodes ?? []) {
    const expected = node === spec.source ? sent : node === spec.sink ? -sent : 0;
    const actual = balance.get(node) ?? 0;
    if (actual !== expected) {
      conservationOk = false;
      conservationDetail = `node "${node}" net outflow ${actual}, expected ${expected}`;
      break;
    }
  }
  checks.push({ name: "conservation", ok: conservationOk, detail: conservationDetail });

  const recomputed = flows.reduce((sum, f) => sum + edgeCost(spec.edges[f.edge]!.segments, f.flow), 0);
  const costOk = recomputed === reportedCost;
  checks.push({
    name: "cost",
    ok: costOk,
    detail: costOk ? undefined : `reported ${reportedCost} but piecewise fees sum to ${recomputed}`,
  });

  let reducedOk = true;
  let reducedDetail: string | undefined;
  for (const f of flows) {
    const edge = spec.edges[f.edge]!;
    const piU = potentials[f.from];
    const piV = potentials[f.to];
    if (piU === undefined || piV === undefined) {
      reducedOk = false;
      reducedDetail = `missing potential for node "${piU === undefined ? f.from : f.to}"`;
      break;
    }
    if (f.flow < edge.capacity) {
      const reduced = marginalCost(edge.segments, f.flow + 1) + piU - piV;
      if (reduced < 0) {
        reducedOk = false;
        reducedDetail = `edge ${f.edge} (${f.from}->${f.to}) forward residual reduced cost ${reduced} < 0`;
        break;
      }
    }
    if (f.flow > 0) {
      const reduced = -marginalCost(edge.segments, f.flow) + piV - piU;
      if (reduced < 0) {
        reducedOk = false;
        reducedDetail = `edge ${f.edge} (${f.from}->${f.to}) backward residual reduced cost ${reduced} < 0`;
        break;
      }
    }
  }
  checks.push({ name: "reduced-costs", ok: reducedOk, detail: reducedDetail });

  return { valid: checks.every((c) => c.ok), checks };
}
