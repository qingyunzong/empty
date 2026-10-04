/** 输入解析与校验：JSON -> Problem。 */
import type { Problem } from "./solver.js";

export const MAX_N = 12;

export function parseProblem(raw: unknown): Problem {
  if (typeof raw !== "object" || raw === null) fail("input must be a JSON object");
  const obj = raw as Record<string, unknown>;

  const orderIds = parseIds(obj.orders, "orders");
  const stationIds = parseIds(obj.stations, "stations");
  const n = orderIds.length;
  if (n !== stationIds.length)
    fail(`orders (${n}) and stations (${stationIds.length}) must be equal in number`);
  if (n < 1 || n > MAX_N) fail(`n must be between 1 and ${MAX_N}, got ${n}`);

  const orderIndex = new Map(orderIds.map((id, i) => [id, i]));
  const stationIndex = new Map(stationIds.map((id, j) => [id, j]));

  const allowed: boolean[][] = Array.from({ length: n }, () => new Array<boolean>(n).fill(true));
  const forbiddenRaw = obj.forbidden ?? [];
  if (!Array.isArray(forbiddenRaw)) fail("forbidden must be an array of [orderId, stationId] pairs");
  for (const pair of forbiddenRaw) {
    if (!Array.isArray(pair) || pair.length !== 2) fail("forbidden entries must be [orderId, stationId]");
    const i = orderIndex.get(String(pair[0]));
    const j = stationIndex.get(String(pair[1]));
    if (i === undefined) fail(`forbidden: unknown order "${pair[0]}"`);
    if (j === undefined) fail(`forbidden: unknown station "${pair[1]}"`);
    allowed[i][j] = false;
  }

  const cost: number[][] = Array.from({ length: n }, () => new Array<number>(n).fill(NaN));
  if (obj.costMatrix !== undefined) {
    const m = obj.costMatrix;
    if (!Array.isArray(m) || m.length !== n || m.some((row) => !Array.isArray(row) || row.length !== n))
      fail(`costMatrix must be a ${n}x${n} matrix`);
    for (let i = 0; i < n; i++)
      for (let j = 0; j < n; j++) {
        const c = (m as unknown[][])[i][j];
        if (typeof c !== "number" || !Number.isFinite(c)) fail(`costMatrix[${i}][${j}] is not a finite number`);
        cost[i][j] = c;
      }
  } else if (obj.costs !== undefined) {
    if (!Array.isArray(obj.costs)) fail("costs must be an array of {order, station, cost}");
    for (const entry of obj.costs) {
      const e = entry as Record<string, unknown>;
      const i = orderIndex.get(String(e.order));
      const j = stationIndex.get(String(e.station));
      if (i === undefined) fail(`costs: unknown order "${e.order}"`);
      if (j === undefined) fail(`costs: unknown station "${e.station}"`);
      if (typeof e.cost !== "number" || !Number.isFinite(e.cost))
        fail(`costs: cost for ${e.order}->${e.station} is not a finite number`);
      cost[i][j] = e.cost;
    }
  } else {
    fail("provide either costMatrix or costs");
  }

  for (let i = 0; i < n; i++)
    for (let j = 0; j < n; j++)
      if (allowed[i][j] && Number.isNaN(cost[i][j]))
        fail(`missing cost for allowed pair ${orderIds[i]} -> ${stationIds[j]}`);
  for (let i = 0; i < n; i++) for (let j = 0; j < n; j++) if (Number.isNaN(cost[i][j])) cost[i][j] = 0;

  return { orderIds, stationIds, cost, allowed };
}

function parseIds(value: unknown, name: string): string[] {
  if (!Array.isArray(value) || value.some((x) => typeof x !== "string"))
    fail(`${name} must be an array of strings`);
  const ids = value as string[];
  if (new Set(ids).size !== ids.length) fail(`${name} contains duplicate ids`);
  return ids;
}

function fail(message: string): never {
  throw new Error(`invalid input: ${message}`);
}
