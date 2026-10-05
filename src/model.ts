// Input model + validation. All quantities and costs are integers.

export const MAX_HORIZON = 12;
export const MAX_CAPACITY = 100000;

export type StreamName = "normal" | "expedited";

export interface PipelineArrival {
  arrivalDay: number;
  qty: number;
  stream?: StreamName;
}

export interface ExpediteSpec {
  leadTime: number;
  fixedCost: number;
  unitCost?: number;
}

export interface WarehouseInput {
  id: string;
  capacity: number;
  initialInventory: number;
  demand: number[];
  leadTime: number;
  fixedOrderCost: number;
  unitCost?: number;
  holdingCost: number;
  expedite?: ExpediteSpec;
  pipeline?: PipelineArrival[];
}

export interface Scenario {
  horizon: number;
  warehouses: WarehouseInput[];
}

export interface PublishedOrder {
  arrivalDay: number;
  qty: number;
  lockedQty?: number;
  stream?: StreamName;
}

export interface ReplanWarehouse {
  id: string;
  inventoryAtNow: number;
  published: PublishedOrder[];
}

export interface ReplanRequest {
  scenario: Scenario;
  now: number;
  lockWindowDays: number;
  warehouses: ReplanWarehouse[];
}

function fail(msg: string): never {
  throw new Error(msg);
}

function reqInt(v: unknown, name: string, min: number, max: number): number {
  if (typeof v !== "number" || !Number.isInteger(v) || v < min || v > max) {
    fail(`${name} must be an integer in [${min}, ${max}], got ${JSON.stringify(v)}`);
  }
  return v as number;
}

function optInt(v: unknown, name: string, min: number, max: number, dflt: number): number {
  if (v === undefined) return dflt;
  return reqInt(v, name, min, max);
}

function asObj(v: unknown, name: string): Record<string, unknown> {
  if (typeof v !== "object" || v === null || Array.isArray(v)) {
    fail(`${name} must be an object`);
  }
  return v as Record<string, unknown>;
}

function parseStream(v: unknown, name: string): StreamName {
  if (v === undefined) return "normal";
  if (v === "normal" || v === "expedited") return v;
  return fail(`${name} must be "normal" or "expedited"`);
}

export function parseWarehouse(raw: unknown, index: number, horizon: number): WarehouseInput {
  const o = asObj(raw, `warehouses[${index}]`);
  const id = o.id === undefined ? `W${index + 1}` : String(o.id);
  const capacity = reqInt(o.capacity, `${id}.capacity`, 0, MAX_CAPACITY);
  const initialInventory = reqInt(o.initialInventory, `${id}.initialInventory`, 0, capacity);
  if (!Array.isArray(o.demand)) fail(`${id}.demand must be an array`);
  if (o.demand.length !== horizon) {
    fail(`${id}.demand must have exactly ${horizon} entries (one per day)`);
  }
  const demand = o.demand.map((d, t) => reqInt(d, `${id}.demand[${t}]`, 0, MAX_CAPACITY));
  const leadTime = reqInt(o.leadTime, `${id}.leadTime`, 0, horizon);
  const fixedOrderCost = reqInt(o.fixedOrderCost, `${id}.fixedOrderCost`, 0, Number.MAX_SAFE_INTEGER);
  const unitCost = optInt(o.unitCost, `${id}.unitCost`, 0, Number.MAX_SAFE_INTEGER, 0);
  const holdingCost = reqInt(o.holdingCost, `${id}.holdingCost`, 0, Number.MAX_SAFE_INTEGER);
  let expedite: ExpediteSpec | undefined;
  if (o.expedite !== undefined) {
    const e = asObj(o.expedite, `${id}.expedite`);
    const eLead = reqInt(e.leadTime, `${id}.expedite.leadTime`, 0, horizon);
    if (eLead >= leadTime) fail(`${id}.expedite.leadTime must be < leadTime (${leadTime})`);
    expedite = {
      leadTime: eLead,
      fixedCost: reqInt(e.fixedCost, `${id}.expedite.fixedCost`, 0, Number.MAX_SAFE_INTEGER),
      unitCost: optInt(e.unitCost, `${id}.expedite.unitCost`, 0, Number.MAX_SAFE_INTEGER, 0),
    };
  }
  const pipeline: PipelineArrival[] = [];
  if (o.pipeline !== undefined) {
    if (!Array.isArray(o.pipeline)) fail(`${id}.pipeline must be an array`);
    o.pipeline.forEach((p, k) => {
      const po = asObj(p, `${id}.pipeline[${k}]`);
      pipeline.push({
        arrivalDay: reqInt(po.arrivalDay, `${id}.pipeline[${k}].arrivalDay`, 0, horizon - 1),
        qty: reqInt(po.qty, `${id}.pipeline[${k}].qty`, 0, MAX_CAPACITY),
        stream: parseStream(po.stream, `${id}.pipeline[${k}].stream`),
      });
    });
  }
  return { id, capacity, initialInventory, demand, leadTime, fixedOrderCost, unitCost, holdingCost, expedite, pipeline };
}

export function parseScenario(raw: unknown): Scenario {
  const o = asObj(raw, "scenario");
  const horizon = reqInt(o.horizon, "horizon", 1, MAX_HORIZON);
  if (!Array.isArray(o.warehouses) || o.warehouses.length === 0) {
    fail("warehouses must be a non-empty array");
  }
  const warehouses = o.warehouses.map((w, i) => parseWarehouse(w, i, horizon));
  const ids = new Set(warehouses.map((w) => w.id));
  if (ids.size !== warehouses.length) fail("warehouse ids must be unique");
  return { horizon, warehouses };
}

export function parseReplanRequest(raw: unknown): ReplanRequest {
  const o = asObj(raw, "replan request");
  const scenario = parseScenario(o.scenario);
  const now = reqInt(o.now, "now", 0, scenario.horizon - 1);
  const lockWindowDays = optInt(o.lockWindowDays, "lockWindowDays", 0, scenario.horizon, 0);
  if (!Array.isArray(o.warehouses) || o.warehouses.length === 0) {
    fail("replan warehouses must be a non-empty array");
  }
  const warehouses = o.warehouses.map((w, i) => {
    const wo = asObj(w, `replan.warehouses[${i}]`);
    const id = String(wo.id ?? "");
    const wh = scenario.warehouses.find((x) => x.id === id);
    if (!wh) fail(`replan.warehouses[${i}].id ${JSON.stringify(id)} not found in scenario`);
    const inventoryAtNow = reqInt(wo.inventoryAtNow, `${id}.inventoryAtNow`, 0, wh.capacity);
    if (!Array.isArray(wo.published)) fail(`${id}.published must be an array`);
    const published = wo.published.map((p, k) => {
      const po = asObj(p, `${id}.published[${k}]`);
      const qty = reqInt(po.qty, `${id}.published[${k}].qty`, 0, MAX_CAPACITY);
      return {
        arrivalDay: reqInt(po.arrivalDay, `${id}.published[${k}].arrivalDay`, now, scenario.horizon - 1),
        qty,
        lockedQty: optInt(po.lockedQty, `${id}.published[${k}].lockedQty`, 0, qty, -1),
        stream: parseStream(po.stream, `${id}.published[${k}].stream`),
      } as PublishedOrder;
    });
    return { id, inventoryAtNow, published };
  });
  return { scenario, now, lockWindowDays, warehouses };
}
