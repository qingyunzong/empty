// Daily inventory certificate: one row per day with conservation checks.

import { SolveInput, DayDecision, simulate } from "./core";

export interface CertRow {
  day: number;
  start: number;
  arrivals: number[]; // per stream
  demand: number;
  end: number;
  money: number;
  dev: number;
}

export function buildCertificate(
  input: SolveInput,
  decisions: DayDecision[],
  firstDay: number
): CertRow[] {
  const rows = simulate(input, decisions);
  if (rows === null) throw new Error("decisions are infeasible; cannot build certificate");
  return rows.map((r, k) => ({
    day: firstDay + k,
    start: r.start,
    arrivals: r.arrivals,
    demand: r.demand,
    end: r.end,
    money: r.money,
    dev: r.dev,
  }));
}

// Conservation: start + arrivals - demand = end; 0 <= end <= capacity;
// next day's start = this day's end.
export function checkCertificate(rows: CertRow[], capacity: number): string[] {
  const errors: string[] = [];
  for (let k = 0; k < rows.length; k++) {
    const r = rows[k];
    let arr = 0;
    for (const a of r.arrivals) {
      if (!Number.isInteger(a) || a < 0) errors.push(`day ${r.day}: bad arrival qty ${a}`);
      arr += a;
    }
    if (r.start + arr - r.demand !== r.end) {
      errors.push(`day ${r.day}: conservation violated: ${r.start}+${arr}-${r.demand} != ${r.end}`);
    }
    if (r.end < 0) errors.push(`day ${r.day}: stockout (end=${r.end})`);
    if (r.end > capacity) errors.push(`day ${r.day}: capacity exceeded (end=${r.end} > ${capacity})`);
    if (k + 1 < rows.length && rows[k + 1].start !== r.end) {
      errors.push(`day ${r.day}: next day starts at ${rows[k + 1].start}, expected ${r.end}`);
    }
  }
  return errors;
}
