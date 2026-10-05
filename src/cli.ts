#!/usr/bin/env node
// inventory-cli: inventory planning under lead time, capacity, fixed order
// cost and holding cost. Integer orders, no stockouts, arrivals land before
// daily demand. Node.js built-ins only.

import { readFileSync } from "node:fs";
import { parseScenario, parseReplanRequest, Scenario, WarehouseInput } from "./model";
import { SolveInput, solve, Cost } from "./core";
import { finiteStateSearch } from "./finitestate";
import { enumerateOptimum } from "./enumerate";
import { buildCertificate, checkCertificate, CertRow } from "./certificate";
import { buildPlanInput } from "./plan";
import { replanWarehouse, ReplanOutcome } from "./replan";

type Writer = (line: string) => void;

const pad = (v: string | number, n: number): string => String(v).padStart(n);
const padL = (v: string | number, n: number): string => String(v).padEnd(n);

function readJson(path: string): unknown {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch (e) {
    throw new Error(`cannot read ${path}: ${(e as Error).message}`);
  }
}

function fmtCost(c: Cost): string {
  return `dev=${c.dev} money=${c.money}`;
}

function certTable(out: Writer, rows: CertRow[], streams: string[]): void {
  const head = ["day", "start", ...streams.map((s) => `arr:${s}`), "demand", "end", "money", "dev"];
  out("  " + head.map((h) => padL(h, 8)).join(""));
  for (const r of rows) {
    const cols = [r.day, r.start, ...r.arrivals, r.demand, r.end, r.money, r.dev];
    out("  " + cols.map((c) => padL(c, 8)).join(""));
  }
}

function verifyAndReport(
  out: Writer,
  label: string,
  input: SolveInput,
  dpCost: Cost,
  dpDecisions: { qty: number[] }[],
  firstDay: number
): boolean {
  let ok = true;
  const rows = buildCertificate(input, dpDecisions, firstDay);
  const errors = checkCertificate(rows, input.capacity);
  if (errors.length === 0) {
    out(`  conservation: OK (${rows.length} days checked, start+arrivals-demand=end)`);
  } else {
    ok = false;
    for (const e of errors) out(`  conservation: FAIL: ${e}`);
  }
  const fs = finiteStateSearch(input);
  const fsCost = fs ? fs.cost : null;
  if (fsCost !== null && fsCost.dev === dpCost.dev && fsCost.money === dpCost.money) {
    out(`  finite-state check: OK (independent search agrees: ${fmtCost(dpCost)})`);
  } else {
    ok = false;
    out(`  finite-state check: MISMATCH dp=${fmtCost(dpCost)} search=${fsCost ? fmtCost(fsCost) : "infeasible"}`);
  }
  void label;
  return ok;
}

function cmdPlan(scenario: Scenario, out: Writer, asJson: boolean): number {
  const report: unknown[] = [];
  let allOk = true;
  let totalMoney = 0;
  for (const wh of scenario.warehouses) {
    const input = buildPlanInput(wh, scenario.horizon);
    const res = solve(input);
    if (!res.feasible) {
      out(`== ${wh.id}: INFEASIBLE (demand cannot be met within capacity/lead time) ==`);
      report.push({ id: wh.id, feasible: false });
      allOk = false;
      continue;
    }
    const rows = buildCertificate(input, res.decisions, 0);
    totalMoney += res.cost.money;
    const orders: unknown[] = [];
    out(`== warehouse ${wh.id} ==`);
    out(
      `  streams: ${input.streams
        .map((s) => `${s.name}(lead=${s.lead}, fixed=${s.fixedCost}, unit=${s.unitCost})`)
        .join(", ")}; holding=${wh.holdingCost}/unit/day; capacity=${wh.capacity}`
    );
    out(`  optimal total cost: money=${res.cost.money}`);
    out("  orders (integer qty, arrival before daily demand):");
    for (let t = 0; t < scenario.horizon; t++) {
      for (let s = 0; s < input.streams.length; s++) {
        const slot = input.slots[t][s];
        const qty = res.decisions[t].qty[s];
        if (slot.counted && qty > 0) {
          const o = {
            placeDay: t - input.streams[s].lead,
            arrivalDay: t,
            stream: input.streams[s].name,
            qty,
          };
          orders.push(o);
          out(`    place day ${o.placeDay} -> arrive day ${o.arrivalDay} [${o.stream}] qty ${o.qty}`);
        } else if (!slot.counted && qty > 0) {
          out(`    committed pipeline arrival day ${t} [${input.streams[s].name}] qty ${qty}`);
        }
      }
    }
    out("  daily inventory certificate:");
    certTable(out, rows, input.streams.map((s) => s.name));
    if (!verifyAndReport(out, wh.id, input, res.cost, res.decisions, 0)) allOk = false;
    report.push({
      id: wh.id,
      feasible: true,
      cost: res.cost,
      orders,
      certificate: rows,
    });
  }
  out(`total money (all warehouses): ${totalMoney}`);
  if (asJson) out(JSON.stringify({ warehouses: report, totalMoney }, null, 2));
  return allOk ? 0 : 1;
}

function cmdVerify(scenario: Scenario, out: Writer, enumeration: boolean): number {
  let ok = true;
  for (const wh of scenario.warehouses) {
    const input = buildPlanInput(wh, scenario.horizon);
    const dp = solve(input);
    const fs = finiteStateSearch(input);
    out(`== warehouse ${wh.id} ==`);
    out(`  dp:            ${dp.feasible ? fmtCost(dp.cost) : "infeasible"}`);
    out(`  finite-state:  ${fs ? fmtCost(fs.cost) : "infeasible"}`);
    const dpC = dp.feasible ? dp.cost : null;
    const fsC = fs ? fs.cost : null;
    const agree =
      (dpC === null && fsC === null) ||
      (dpC !== null && fsC !== null && dpC.dev === fsC.dev && dpC.money === fsC.money);
    if (!agree) ok = false;
    out(`  => ${agree ? "MATCH" : "MISMATCH"}`);
    if (enumeration) {
      try {
        const en = enumerateOptimum(input);
        out(`  enumeration:   ${en ? fmtCost(en) : "infeasible"}`);
        const agree2 =
          (dpC === null && en === null) ||
          (dpC !== null && en !== null && dpC.dev === en.dev && dpC.money === en.money);
        if (!agree2) ok = false;
        out(`  => ${agree2 ? "MATCH" : "MISMATCH"}`);
      } catch (e) {
        out(`  enumeration:   skipped (${(e as Error).message})`);
      }
    }
  }
  return ok ? 0 : 1;
}

function cmdReplan(raw: unknown, out: Writer, asJson: boolean): number {
  const req = parseReplanRequest(raw);
  const H = req.scenario.horizon;
  const report: unknown[] = [];
  let allOk = true;
  let totalNew = 0;
  let totalBase = 0;
  let baseComplete = true;
  for (const rw of req.warehouses) {
    const wh = req.scenario.warehouses.find((w) => w.id === rw.id) as WarehouseInput;
    const outcome: ReplanOutcome = replanWarehouse(
      wh,
      H,
      req.now,
      rw.inventoryAtNow,
      rw.published,
      req.lockWindowDays
    );
    out(`== warehouse ${wh.id}: replan at day ${req.now} (corrected demand: [${wh.demand.join(", ")}]) ==`);
    if (!outcome.result.feasible) {
      out("  INFEASIBLE under corrected demand");
      report.push({ id: wh.id, feasible: false });
      allOk = false;
      continue;
    }
    out(`  published-order changes (locked portion cannot be cancelled):`);
    if (outcome.changes.length === 0) out("    (none)");
    for (const c of outcome.changes) {
      out(
        `    arrive day ${c.arrivalDay} [${c.stream}] published=${c.published} locked=${c.locked} -> new=${c.newQty} (delta ${c.delta >= 0 ? "+" : ""}${c.delta})`
      );
    }
    if (outcome.newOrders.length > 0) {
      out("  new orders:");
      for (const o of outcome.newOrders) {
        out(`    place day ${o.placeDay} -> arrive day ${o.arrivalDay} [${o.stream}] qty ${o.qty}`);
      }
    }
    out(`  deviation from published quantities: ${outcome.totalDeviation} unit(s) (minimized first)`);
    out(`  money: replanned=${outcome.newMoney}` +
      (outcome.baselineMoney !== null ? ` baseline(keep published)=${outcome.baselineMoney}` : " baseline=infeasible"));
    out(
      `  net difference: ${
        outcome.netDifference !== null
          ? (outcome.netDifference >= 0 ? "+" : "") + outcome.netDifference
          : "n/a (baseline infeasible)"
      }`
    );
    const rows = buildCertificate(outcome.input, outcome.result.decisions, req.now);
    out("  daily conservation certificate:");
    certTable(out, rows, outcome.input.streams.map((s) => s.name));
    if (!verifyAndReport(out, wh.id, outcome.input, outcome.result.cost, outcome.result.decisions, req.now)) {
      allOk = false;
    }
    totalNew += outcome.newMoney;
    if (outcome.baselineMoney !== null) totalBase += outcome.baselineMoney;
    else baseComplete = false;
    report.push({
      id: wh.id,
      feasible: true,
      deviation: outcome.totalDeviation,
      newMoney: outcome.newMoney,
      baselineMoney: outcome.baselineMoney,
      netDifference: outcome.netDifference,
      changes: outcome.changes,
      newOrders: outcome.newOrders,
      certificate: rows,
    });
  }
  out(`total money (all warehouses): replanned=${totalNew}` + (baseComplete ? ` baseline=${totalBase} net=${totalNew - totalBase >= 0 ? "+" : ""}${totalNew - totalBase}` : ""));
  if (asJson) out(JSON.stringify({ warehouses: report }, null, 2));
  return allOk ? 0 : 1;
}

const USAGE = `usage:
  inventory-cli plan <scenario.json> [--json]        optimal integer orders + daily certificate
  inventory-cli verify <scenario.json>               DP vs independent finite-state search
  inventory-cli crosscheck <scenario.json>           DP vs short-period exhaustive enumeration
  inventory-cli replan <replan.json> [--json]        replan under corrected demand
                                                     (min change to published orders, then min cost)`;

export function run(args: string[], out: Writer): number {
  const [cmd, file] = args;
  const asJson = args.includes("--json");
  try {
    switch (cmd) {
      case "plan":
        if (!file) throw new Error("missing scenario file");
        return cmdPlan(parseScenario(readJson(file)), out, asJson);
      case "verify":
        if (!file) throw new Error("missing scenario file");
        return cmdVerify(parseScenario(readJson(file)), out, false) === 0
          ? (out("all warehouses: finite-state search agrees with DP"), 0)
          : 1;
      case "crosscheck":
        if (!file) throw new Error("missing scenario file");
        return cmdVerify(parseScenario(readJson(file)), out, true);
      case "replan":
        if (!file) throw new Error("missing replan file");
        return cmdReplan(readJson(file), out, asJson);
      default:
        out(USAGE);
        return cmd === undefined || cmd === "help" || cmd === "--help" ? 0 : 2;
    }
  } catch (e) {
    out(`error: ${(e as Error).message}`);
    return 2;
  }
}

if (require.main === module) {
  process.exitCode = run(process.argv.slice(2), (l) => console.log(l));
}
