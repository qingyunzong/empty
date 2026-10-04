import { readFileSync } from "node:fs";
import { Instance, Station } from "./types";

function assertInt(value: unknown, field: string): asserts value is number {
  if (typeof value !== "number" || !Number.isInteger(value)) {
    throw new Error(`invalid instance: ${field} must be an integer, got ${JSON.stringify(value)}`);
  }
}

export function validateInstance(raw: unknown): Instance {
  if (typeof raw !== "object" || raw === null) throw new Error("invalid instance: not an object");
  const obj = raw as Record<string, unknown>;
  if (typeof obj.name !== "string") throw new Error("invalid instance: name must be a string");
  assertInt(obj.depot, "depot");
  assertInt(obj.timeLimit, "timeLimit");
  if (!Array.isArray(obj.stations) || obj.stations.length === 0) {
    throw new Error("invalid instance: stations must be a non-empty array");
  }
  const stations: Station[] = obj.stations.map((s: unknown, i: number) => {
    if (typeof s !== "object" || s === null) throw new Error(`invalid station #${i}`);
    const st = s as Record<string, unknown>;
    assertInt(st.id, `stations[${i}].id`);
    if (typeof st.name !== "string") throw new Error(`stations[${i}].name must be a string`);
    assertInt(st.x, `stations[${i}].x`);
    assertInt(st.y, `stations[${i}].y`);
    assertInt(st.service, `stations[${i}].service`);
    assertInt(st.open, `stations[${i}].open`);
    assertInt(st.close, `stations[${i}].close`);
    assertInt(st.profit, `stations[${i}].profit`);
    const station: Station = {
      id: st.id, name: st.name, x: st.x, y: st.y,
      service: st.service, open: st.open, close: st.close, profit: st.profit,
    };
    if (station.service < 0) throw new Error(`station ${station.name}: negative service`);
    if (station.open > station.close) throw new Error(`station ${station.name}: open > close`);
    if (station.profit < 0) throw new Error(`station ${station.name}: negative profit`);
    return station;
  });
  const ids = new Set(stations.map((s) => s.id));
  if (ids.size !== stations.length) throw new Error("invalid instance: duplicate station ids");
  if (obj.depot < 0 || obj.depot >= stations.length) throw new Error("invalid instance: depot index out of range");
  if (obj.timeLimit < 0) throw new Error("invalid instance: negative timeLimit");
  if (stations.length - 1 > 16) throw new Error("invalid instance: at most 16 stations supported");
  return { name: obj.name, depot: obj.depot, timeLimit: obj.timeLimit, stations };
}

export function loadInstance(path: string): Instance {
  return validateInstance(JSON.parse(readFileSync(path, "utf8")));
}

/**
 * Symmetric integer travel matrix: rounded Euclidean distance.
 * Used both as travel time and as route distance.
 */
export function travelMatrix(instance: Instance): number[][] {
  const n = instance.stations.length;
  const d: number[][] = Array.from({ length: n }, () => new Array<number>(n).fill(0));
  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) {
      const a = instance.stations[i]!;
      const b = instance.stations[j]!;
      const w = Math.round(Math.hypot(a.x - b.x, a.y - b.y));
      d[i]![j] = w;
      d[j]![i] = w;
    }
  }
  return d;
}
