/**
 * 证书核对：不依赖求解器内部状态，按问题输入对路线证书逐步正向模拟，
 * 检查时间衔接（含空驶）、时间窗、每单至多一车、收益与空驶费汇总。
 */
import { ProblemInput, validateInput } from "./types";
import { Certificate } from "./solver";

export interface VerifyResult {
  ok: boolean;
  errors: string[];
}

export function verifyCertificate(input: ProblemInput, cert: Certificate): VerifyResult {
  const errors: string[] = [];
  validateInput(input);
  const T = input.travelTime;
  const n = input.orders.length;
  const V = input.vehicles.length;
  const served = new Array<number>(n).fill(0);

  let totalRevenue = 0;
  let totalEmpty = 0;

  for (const route of cert.routes) {
    const vi = route.vehicleIndex;
    if (!Number.isInteger(vi) || vi < 0 || vi >= V) {
      errors.push(`路线车辆下标越界: ${vi}`);
      continue;
    }
    const veh = input.vehicles[vi];
    if (route.vehicleId !== veh.id)
      errors.push(`车辆 id 不符: 证书 ${route.vehicleId} / 输入 ${veh.id}`);
    if (route.startPoint !== veh.startPoint)
      errors.push(`车辆 ${veh.id} 初始点不符`);
    if (route.departTime !== veh.availableTime)
      errors.push(`车辆 ${veh.id} 出发时刻不符`);

    let loc = veh.startPoint;
    let time = veh.availableTime;
    let emptySum = 0;
    let revenueSum = 0;
    for (const stop of route.stops) {
      const oi = stop.orderIndex;
      if (!Number.isInteger(oi) || oi < 0 || oi >= n) {
        errors.push(`车辆 ${veh.id} 含越界订单下标 ${oi}`);
        continue;
      }
      const o = input.orders[oi];
      served[oi]++;
      if (stop.orderId !== o.id)
        errors.push(`订单 id 不符: 证书 ${stop.orderId} / 输入 ${o.id}`);
      if (stop.pickup !== o.pickup || stop.delivery !== o.delivery)
        errors.push(`订单 ${o.id} 起讫点不符`);

      const empty = T[loc][o.pickup];
      if (stop.emptyTravelFromPrev !== empty)
        errors.push(`订单 ${o.id} 空驶时间不符: 证书 ${stop.emptyTravelFromPrev} / 应为 ${empty}`);
      const arrivePickup = time + empty;
      if (stop.arrivePickup !== arrivePickup)
        errors.push(`订单 ${o.id} 到达取货点时刻不符`);
      const startService = Math.max(arrivePickup, o.readyTime);
      if (stop.startService !== startService)
        errors.push(`订单 ${o.id} 开始服务时刻不符`);
      const departPickup = startService + o.serviceTime;
      if (stop.departPickup !== departPickup)
        errors.push(`订单 ${o.id} 离开取货点时刻不符`);
      const arriveDelivery = departPickup + T[o.pickup][o.delivery];
      if (stop.arriveDelivery !== arriveDelivery)
        errors.push(`订单 ${o.id} 送达时刻不符`);
      if (arriveDelivery > o.deadline)
        errors.push(`订单 ${o.id} 超过截止时间: ${arriveDelivery} > ${o.deadline}`);

      emptySum += empty;
      revenueSum += o.revenue;
      loc = o.delivery;
      time = arriveDelivery;
    }
    if (route.finishTime !== time) errors.push(`车辆 ${veh.id} 完成时刻不符`);
    if (route.emptyTravelTime !== emptySum) errors.push(`车辆 ${veh.id} 空驶时间合计不符`);
    if (route.revenue !== revenueSum) errors.push(`车辆 ${veh.id} 收益合计不符`);
    totalRevenue += revenueSum;
    totalEmpty += emptySum;
  }

  for (let i = 0; i < n; i++) {
    if (served[i] > 1) errors.push(`订单 ${input.orders[i].id} 被服务 ${served[i]} 次`);
    const expect = served[i] === 1;
    const got = cert.assignment[i] >= 0;
    if (expect !== got)
      errors.push(`订单 ${input.orders[i].id} 的 assignment 标记与路线不一致`);
    if (cert.assignment[i] >= V)
      errors.push(`订单 ${input.orders[i].id} 分配到越界车辆 ${cert.assignment[i]}`);
  }

  const totalEmptyCost = totalEmpty * input.emptyCostPerUnitTime;
  if (cert.totalRevenue !== totalRevenue) errors.push("totalRevenue 汇总不符");
  if (cert.totalEmptyTravelTime !== totalEmpty) errors.push("totalEmptyTravelTime 汇总不符");
  if (cert.totalEmptyCost !== totalEmptyCost) errors.push("totalEmptyCost 汇总不符");
  if (cert.objectiveValue !== totalRevenue - totalEmptyCost)
    errors.push("objectiveValue 汇总不符");

  const unassignedExpect = input.orders.filter((_, i) => served[i] === 0).map((o) => o.id);
  if (JSON.stringify(cert.unassigned) !== JSON.stringify(unassignedExpect))
    errors.push("unassigned 列表不符");

  return { ok: errors.length === 0, errors };
}
