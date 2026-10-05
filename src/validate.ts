import type { PlanInput } from "./types.js";

export const MAX_ORDERS = 14;

function checkNumber(value: unknown, name: string, allowInfinity: boolean): void {
  if (typeof value !== "number" || Number.isNaN(value)) {
    throw new TypeError(`${name} must be a number`);
  }
  if (!allowInfinity && !Number.isFinite(value)) {
    throw new TypeError(`${name} must be finite`);
  }
}

/** 校验输入合法性；不合法时抛出 TypeError / RangeError。 */
export function validateInput(input: PlanInput): void {
  if (input === null || typeof input !== "object") {
    throw new TypeError("input must be an object");
  }
  const { orders, vehicles, emptyTime } = input;
  if (!Array.isArray(orders)) throw new TypeError("input.orders must be an array");
  if (orders.length > MAX_ORDERS) {
    throw new RangeError(`input.orders: at most ${MAX_ORDERS} orders supported, got ${orders.length}`);
  }
  if (!Array.isArray(vehicles) || vehicles.length === 0) {
    throw new TypeError("input.vehicles must be a non-empty array");
  }
  if (!Array.isArray(emptyTime)) throw new TypeError("input.emptyTime must be a matrix");
  const locCount = emptyTime.length;
  if (locCount === 0 && (orders.length > 0 || vehicles.length > 0)) {
    if (orders.length > 0) throw new TypeError("input.emptyTime must not be empty when orders exist");
  }
  emptyTime.forEach((row, r) => {
    if (!Array.isArray(row) || row.length !== locCount) {
      throw new TypeError(`input.emptyTime must be a square matrix (row ${r} has wrong length)`);
    }
    row.forEach((x, c) => {
      checkNumber(x, `input.emptyTime[${r}][${c}]`, false);
      if (x < 0) throw new TypeError(`input.emptyTime[${r}][${c}] must be >= 0`);
    });
  });
  const orderIds = new Set<string>();
  orders.forEach((o, i) => {
    if (o === null || typeof o !== "object") throw new TypeError(`orders[${i}] must be an object`);
    if (typeof o.id !== "string" || o.id.length === 0) throw new TypeError(`orders[${i}].id must be a non-empty string`);
    if (orderIds.has(o.id)) throw new TypeError(`orders[${i}].id duplicated: ${o.id}`);
    orderIds.add(o.id);
    if (!Number.isInteger(o.location) || o.location < 0 || o.location >= locCount) {
      throw new TypeError(`orders[${i}].location out of range: ${o.location}`);
    }
    checkNumber(o.readyTime, `orders[${i}].readyTime`, false);
    checkNumber(o.dueTime, `orders[${i}].dueTime`, true);
    if (o.dueTime < o.readyTime) throw new TypeError(`orders[${i}].dueTime < readyTime`);
    checkNumber(o.duration, `orders[${i}].duration`, false);
    if (o.duration < 0) throw new TypeError(`orders[${i}].duration must be >= 0`);
    checkNumber(o.revenue, `orders[${i}].revenue`, false);
  });
  const vehicleIds = new Set<string>();
  vehicles.forEach((v, i) => {
    if (v === null || typeof v !== "object") throw new TypeError(`vehicles[${i}] must be an object`);
    if (typeof v.id !== "string" || v.id.length === 0) throw new TypeError(`vehicles[${i}].id must be a non-empty string`);
    if (vehicleIds.has(v.id)) throw new TypeError(`vehicles[${i}].id duplicated: ${v.id}`);
    vehicleIds.add(v.id);
    if (!Number.isInteger(v.startLocation) || v.startLocation < 0 || v.startLocation >= locCount) {
      throw new TypeError(`vehicles[${i}].startLocation out of range: ${v.startLocation}`);
    }
    checkNumber(v.availableTime, `vehicles[${i}].availableTime`, false);
    checkNumber(v.costPerUnitTime, `vehicles[${i}].costPerUnitTime`, false);
    if (v.costPerUnitTime < 0) throw new TypeError(`vehicles[${i}].costPerUnitTime must be >= 0`);
  });
}
