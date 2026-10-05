/** 订单：地点、时间窗 [readyTime, dueTime]（服务开始时刻约束）、时长与收益。 */
export interface Order {
  id: string;
  location: number;
  readyTime: number;
  dueTime: number;
  duration: number;
  revenue: number;
}

/** 车辆：初始点、可用时刻、单位空驶时间费用。 */
export interface Vehicle {
  id: string;
  startLocation: number;
  availableTime: number;
  costPerUnitTime: number;
}

/** 规划输入：至多 14 个订单、至少 1 辆车、地点间空驶时间矩阵。 */
export interface PlanInput {
  orders: Order[];
  vehicles: Vehicle[];
  emptyTime: number[][];
}

/** 路线中的一个停靠点（时间均含空驶衔接）。 */
export interface RouteStop {
  orderIndex: number;
  orderId: string;
  location: number;
  emptyTimeFromPrev: number;
  arrivalTime: number;
  startTime: number;
  completionTime: number;
}

/** 一辆车的路线及其收益/空驶费核算。 */
export interface VehicleRoute {
  vehicleIndex: number;
  vehicleId: string;
  stops: RouteStop[];
  emptyTime: number;
  emptyCost: number;
  revenue: number;
  profit: number;
}

/** 路线证书：分配结果 + 每条路线的时间线 + 总账，可被独立核对。 */
export interface PlanCertificate {
  profit: number;
  totalRevenue: number;
  totalEmptyCost: number;
  /** 每个订单（按输入序）分到的车辆下标；null 表示未分配。 */
  assignment: (number | null)[];
  routes: VehicleRoute[];
}
