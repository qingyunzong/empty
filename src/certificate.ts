import { Certificate, CertificateStop, Instance } from "./types";
import { travelMatrix } from "./instance";

/**
 * Build the arrival/departure certificate for a route (station ids, depot excluded).
 * Throws if the route is infeasible.
 */
export function buildCertificate(instance: Instance, routeIds: number[]): Certificate {
  const d = travelMatrix(instance);
  const byId = new Map(instance.stations.map((s, i) => [s.id, i]));
  const depot = instance.stations[instance.depot]!;

  const stops: CertificateStop[] = [];
  let time = 0;
  let distance = 0;
  let profit = 0;
  let cur = instance.depot;
  const seen = new Set<number>();

  for (const id of routeIds) {
    const j = byId.get(id);
    if (j === undefined) throw new Error(`certificate: unknown station id ${id}`);
    if (j === instance.depot) throw new Error("certificate: depot must not appear in route");
    if (seen.has(id)) throw new Error(`certificate: station ${id} visited twice`);
    seen.add(id);
    const st = instance.stations[j]!;
    time += d[cur]![j]!;
    distance += d[cur]![j]!;
    const arrival = time;
    const serviceStart = Math.max(arrival, st.open);
    if (serviceStart > st.close) {
      throw new Error(
        `certificate: station ${st.name} window missed (arrival ${arrival}, window [${st.open}, ${st.close}])`,
      );
    }
    const departure = serviceStart + st.service;
    stops.push({
      station: id,
      name: st.name,
      arrival,
      wait: serviceStart - arrival,
      serviceStart,
      departure,
      profit: st.profit,
    });
    profit += st.profit;
    time = departure;
    cur = j;
  }

  time += d[cur]![instance.depot]!;
  distance += d[cur]![instance.depot]!;
  if (time > instance.timeLimit) {
    throw new Error(`certificate: return time ${time} exceeds limit ${instance.timeLimit}`);
  }

  return {
    instance: instance.name,
    timeLimit: instance.timeLimit,
    stops,
    returnTime: time,
    totalProfit: profit,
    totalDistance: distance,
    totalTime: time,
  };
}

export interface ValidationResult {
  ok: boolean;
  errors: string[];
}

/**
 * Independently validate a certificate against an instance:
 * recomputes every arrival/departure from scratch and checks all constraints.
 */
export function validateCertificate(instance: Instance, cert: Certificate): ValidationResult {
  const errors: string[] = [];
  const byId = new Map(instance.stations.map((s, i) => [s.id, i]));
  const d = travelMatrix(instance);
  const depot = instance.stations[instance.depot]!;

  if (cert.instance !== instance.name) errors.push(`instance name mismatch: ${cert.instance} != ${instance.name}`);
  if (cert.timeLimit !== instance.timeLimit) errors.push("timeLimit mismatch");

  let time = 0;
  let distance = 0;
  let profit = 0;
  let cur = instance.depot;
  const seen = new Set<number>();

  cert.stops.forEach((stop, k) => {
    const j = byId.get(stop.station);
    if (j === undefined) {
      errors.push(`stop ${k}: unknown station id ${stop.station}`);
      return;
    }
    if (j === instance.depot) errors.push(`stop ${k}: depot in route`);
    if (seen.has(stop.station)) errors.push(`stop ${k}: station ${stop.station} visited twice`);
    seen.add(stop.station);
    const st = instance.stations[j]!;
    if (stop.name !== st.name) errors.push(`stop ${k}: name mismatch ${stop.name} != ${st.name}`);
    time += d[cur]![j]!;
    distance += d[cur]![j]!;
    if (stop.arrival !== time) errors.push(`stop ${k} (${st.name}): arrival ${stop.arrival} != recomputed ${time}`);
    const serviceStart = Math.max(time, st.open);
    if (stop.wait !== serviceStart - time) errors.push(`stop ${k} (${st.name}): wait ${stop.wait} != ${serviceStart - time}`);
    if (stop.serviceStart !== serviceStart) errors.push(`stop ${k} (${st.name}): serviceStart ${stop.serviceStart} != ${serviceStart}`);
    if (serviceStart > st.close) errors.push(`stop ${k} (${st.name}): window [${st.open}, ${st.close}] violated at ${serviceStart}`);
    const departure = serviceStart + st.service;
    if (stop.departure !== departure) errors.push(`stop ${k} (${st.name}): departure ${stop.departure} != ${departure}`);
    if (stop.profit !== st.profit) errors.push(`stop ${k} (${st.name}): profit ${stop.profit} != ${st.profit}`);
    profit += st.profit;
    time = departure;
    cur = j;
  });

  time += d[cur]![instance.depot]!;
  distance += d[cur]![instance.depot]!;
  if (cert.returnTime !== time) errors.push(`returnTime ${cert.returnTime} != recomputed ${time}`);
  if (cert.totalTime !== time) errors.push(`totalTime ${cert.totalTime} != recomputed ${time}`);
  if (cert.totalDistance !== distance) errors.push(`totalDistance ${cert.totalDistance} != recomputed ${distance}`);
  if (cert.totalProfit !== profit) errors.push(`totalProfit ${cert.totalProfit} != recomputed ${profit}`);
  if (time > instance.timeLimit) errors.push(`total time ${time} exceeds limit ${instance.timeLimit}`);
  void depot;

  return { ok: errors.length === 0, errors };
}

export function formatCertificate(instance: Instance, cert: Certificate): string {
  const depot = instance.stations[instance.depot]!;
  const lines: string[] = [];
  lines.push(`Instance: ${cert.instance}   time limit: ${cert.timeLimit}`);
  lines.push(`Route: ${depot.name} -> ${cert.stops.map((s) => s.name).join(" -> ")}${cert.stops.length ? " -> " : ""}${depot.name}`);
  lines.push("");
  lines.push(pad("STATION", 10) + pad("ARR", 6) + pad("WAIT", 6) + pad("SERVE", 7) + pad("DEP", 6) + pad("WINDOW", 12) + "PROFIT");
  const byId = new Map(instance.stations.map((s) => [s.id, s]));
  for (const s of cert.stops) {
    const st = byId.get(s.station)!;
    lines.push(
      pad(s.name, 10) +
        pad(String(s.arrival), 6) +
        pad(String(s.wait), 6) +
        pad(String(s.serviceStart), 7) +
        pad(String(s.departure), 6) +
        pad(`[${st.open}, ${st.close}]`, 12) +
        String(s.profit),
    );
  }
  lines.push("");
  lines.push(`Return to ${depot.name} at t=${cert.returnTime} (limit ${cert.timeLimit})`);
  lines.push(`Total profit:   ${cert.totalProfit}`);
  lines.push(`Total distance: ${cert.totalDistance}`);
  lines.push(`Total time:     ${cert.totalTime}`);
  return lines.join("\n");
}

function pad(s: string, w: number): string {
  return s.length >= w ? s + " " : s + " ".repeat(w - s.length);
}
