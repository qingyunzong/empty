import type { PlanCertificate, PlanInput } from "./types.js";
import { validateInput } from "./validate.js";

/**
 * 独立核对路线证书：重算每条路线的时间衔接（含空驶）、每单至多一车、
 * 分配一致性以及总账。返回错误列表，空数组表示证书有效。
 */
export function verifyCertificate(input: PlanInput, cert: PlanCertificate): string[] {
  const errors: string[] = [];
  validateInput(input);
  const n = input.orders.length;
  const V = input.vehicles.length;
  if (cert === null || typeof cert !== "object") return ["certificate must be an object"];

  if (!Array.isArray(cert.assignment) || cert.assignment.length !== n) {
    errors.push(`assignment must have length ${n}`);
  } else {
    cert.assignment.forEach((a, i) => {
      if (a !== null && (!Number.isInteger(a) || a < 0 || a >= V)) {
        errors.push(`assignment[${i}] invalid vehicle index: ${a}`);
      }
    });
  }
  if (!Array.isArray(cert.routes)) {
    errors.push("routes must be an array");
    return errors;
  }

  const seenVehicle = new Set<number>();
  const orderVehicle = new Map<number, number>();
  let sumRevenue = 0;
  let sumEmptyCost = 0;

  for (const route of cert.routes) {
    const v = route.vehicleIndex;
    if (!Number.isInteger(v) || v < 0 || v >= V) {
      errors.push(`route has invalid vehicleIndex: ${v}`);
      continue;
    }
    if (seenVehicle.has(v)) errors.push(`vehicle ${v} has more than one route`);
    seenVehicle.add(v);
    const vehicle = input.vehicles[v];
    if (route.vehicleId !== vehicle.id) {
      errors.push(`route of vehicle ${v}: vehicleId mismatch (${route.vehicleId} != ${vehicle.id})`);
    }
    let loc = vehicle.startLocation;
    let time = vehicle.availableTime;
    let empty = 0;
    let revenue = 0;
    route.stops.forEach((stop, k) => {
      const oi = stop.orderIndex;
      if (!Number.isInteger(oi) || oi < 0 || oi >= n) {
        errors.push(`vehicle ${v} stop ${k}: invalid orderIndex ${oi}`);
        return;
      }
      if (orderVehicle.has(oi)) {
        errors.push(`order ${oi} served by both vehicle ${orderVehicle.get(oi)} and vehicle ${v}`);
      }
      orderVehicle.set(oi, v);
      const o = input.orders[oi];
      if (stop.orderId !== o.id) errors.push(`vehicle ${v} stop ${k}: orderId mismatch`);
      if (stop.location !== o.location) errors.push(`vehicle ${v} stop ${k}: location mismatch`);
      const leg = input.emptyTime[loc][o.location];
      if (stop.emptyTimeFromPrev !== leg) {
        errors.push(`vehicle ${v} stop ${k}: emptyTimeFromPrev ${stop.emptyTimeFromPrev} != ${leg}`);
      }
      const arrival = time + leg;
      if (stop.arrivalTime !== arrival) {
        errors.push(`vehicle ${v} stop ${k}: arrivalTime ${stop.arrivalTime} != ${arrival}`);
      }
      const start = Math.max(arrival, o.readyTime);
      if (stop.startTime !== start) {
        errors.push(`vehicle ${v} stop ${k}: startTime ${stop.startTime} != ${start}`);
      }
      if (start > o.dueTime) {
        errors.push(`vehicle ${v} stop ${k}: order ${oi} starts at ${start} after dueTime ${o.dueTime}`);
      }
      const completion = start + o.duration;
      if (stop.completionTime !== completion) {
        errors.push(`vehicle ${v} stop ${k}: completionTime ${stop.completionTime} != ${completion}`);
      }
      empty += leg;
      revenue += o.revenue;
      loc = o.location;
      time = completion;
    });
    const emptyCost = empty * vehicle.costPerUnitTime;
    if (route.emptyTime !== empty) errors.push(`vehicle ${v}: emptyTime ${route.emptyTime} != ${empty}`);
    if (route.emptyCost !== emptyCost) errors.push(`vehicle ${v}: emptyCost ${route.emptyCost} != ${emptyCost}`);
    if (route.revenue !== revenue) errors.push(`vehicle ${v}: revenue ${route.revenue} != ${revenue}`);
    if (route.profit !== revenue - emptyCost) {
      errors.push(`vehicle ${v}: profit ${route.profit} != ${revenue - emptyCost}`);
    }
    sumRevenue += revenue;
    sumEmptyCost += emptyCost;
  }

  if (Array.isArray(cert.assignment) && cert.assignment.length === n) {
    for (let i = 0; i < n; i++) {
      const a = cert.assignment[i];
      const servedBy = orderVehicle.get(i);
      if (a === null && servedBy !== undefined) {
        errors.push(`order ${i} marked unassigned but appears in route of vehicle ${servedBy}`);
      }
      if (a !== null && servedBy !== a) {
        errors.push(`order ${i} assigned to vehicle ${a} but served by ${servedBy ?? "nobody"}`);
      }
    }
  }
  if (cert.totalRevenue !== sumRevenue) {
    errors.push(`totalRevenue ${cert.totalRevenue} != ${sumRevenue}`);
  }
  if (cert.totalEmptyCost !== sumEmptyCost) {
    errors.push(`totalEmptyCost ${cert.totalEmptyCost} != ${sumEmptyCost}`);
  }
  if (cert.profit !== sumRevenue - sumEmptyCost) {
    errors.push(`profit ${cert.profit} != ${sumRevenue - sumEmptyCost}`);
  }
  return errors;
}
