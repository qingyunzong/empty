import type { PlanInput, RouteStop } from "./types.js";

export interface SimulatedRoute {
  stops: RouteStop[];
  emptyTime: number;
  revenue: number;
  feasible: boolean;
}

/** 按顺序模拟一辆车的路线：衔接时间 = 上一单完成时刻 + 空驶时间；到达早于 readyTime 则等待。 */
export function simulateRoute(input: PlanInput, vehicleIndex: number, orderIndices: number[]): SimulatedRoute {
  const vehicle = input.vehicles[vehicleIndex];
  const stops: RouteStop[] = [];
  let loc = vehicle.startLocation;
  let time = vehicle.availableTime;
  let empty = 0;
  let revenue = 0;
  let feasible = true;
  for (const oi of orderIndices) {
    const order = input.orders[oi];
    const leg = input.emptyTime[loc][order.location];
    const arrival = time + leg;
    const start = Math.max(arrival, order.readyTime);
    if (start > order.dueTime) feasible = false;
    const completion = start + order.duration;
    stops.push({
      orderIndex: oi,
      orderId: order.id,
      location: order.location,
      emptyTimeFromPrev: leg,
      arrivalTime: arrival,
      startTime: start,
      completionTime: completion,
    });
    empty += leg;
    revenue += order.revenue;
    loc = order.location;
    time = completion;
  }
  return { stops, emptyTime: empty, revenue, feasible };
}
