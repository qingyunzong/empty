/**
 * 车辆规划问题模型。
 *
 * 输入：车辆初始点、至多 14 个订单、点与点之间的行驶时间矩阵。
 * 订单由取货点、送货点、可开始时间、截止时间与收益组成；
 * 车辆从初始点出发，按顺序服务一串订单，相邻订单之间需要空驶
 * （从上一单送货点空驶到下一单取货点），时间衔接包含该空驶时间。
 * 目标：总收益 - 空驶费（空驶时间 × 单位费率）最大；
 * 并列时按订单分配序列取字典序最小（订单编号顺序，车辆编号小者优先，
 * “未分配”视为最大编号，即分配优于不分配）。
 */

export const MAX_ORDERS = 14;

export interface Order {
  /** 订单唯一标识 */
  id: string;
  /** 取货点（节点编号，0..points-1） */
  pickup: number;
  /** 送货点（节点编号） */
  delivery: number;
  /** 取货可开始时间（最早开始服务时刻，整数） */
  readyTime: number;
  /** 送达截止时间（完成送货不得晚于该时刻，整数） */
  deadline: number;
  /** 取货点装货服务时长（整数，>=0） */
  serviceTime: number;
  /** 完成该单的收益（整数） */
  revenue: number;
}

export interface Vehicle {
  /** 车辆唯一标识 */
  id: string;
  /** 初始所在点（节点编号） */
  startPoint: number;
  /** 可出发时刻（整数，>=0） */
  availableTime: number;
}

export interface ProblemInput {
  /** 节点数量，时间矩阵为 points x points */
  points: number;
  /**
   * 行驶时间矩阵 travelTime[i][j]：从点 i 到点 j 的时间。
   * 既用于车辆空驶（ reposition ），也用于订单取货点到送货点的在途行驶。
   */
  travelTime: number[][];
  /** 空驶费率：每单位空驶时间的费用（整数，>=0） */
  emptyCostPerUnitTime: number;
  vehicles: Vehicle[];
  /** 至多 MAX_ORDERS(14) 个订单 */
  orders: Order[];
}

function isInt(x: unknown): x is number {
  return typeof x === "number" && Number.isInteger(x);
}

/** 校验输入合法性，不合法时抛出 Error。 */
export function validateInput(input: ProblemInput): void {
  if (!input || typeof input !== "object") throw new Error("input 不能为空");
  const { points, travelTime, emptyCostPerUnitTime, vehicles, orders } = input;
  if (!isInt(points) || points < 1) throw new Error("points 必须为 >=1 的整数");
  if (!Array.isArray(travelTime) || travelTime.length !== points)
    throw new Error("travelTime 行数必须等于 points");
  for (let i = 0; i < points; i++) {
    const row = travelTime[i];
    if (!Array.isArray(row) || row.length !== points)
      throw new Error(`travelTime[${i}] 长度必须等于 points`);
    for (let j = 0; j < points; j++) {
      if (!isInt(row[j]) || row[j] < 0)
        throw new Error(`travelTime[${i}][${j}] 必须为非负整数`);
    }
    if (row[i] !== 0) throw new Error(`travelTime[${i}][${i}] 必须为 0`);
  }
  if (!isInt(emptyCostPerUnitTime) || emptyCostPerUnitTime < 0)
    throw new Error("emptyCostPerUnitTime 必须为非负整数");
  if (!Array.isArray(vehicles)) throw new Error("vehicles 必须为数组");
  const vids = new Set<string>();
  vehicles.forEach((v, k) => {
    if (typeof v.id !== "string" || v.id.length === 0)
      throw new Error(`vehicles[${k}].id 必须为非空字符串`);
    if (vids.has(v.id)) throw new Error(`车辆 id 重复: ${v.id}`);
    vids.add(v.id);
    if (!isInt(v.startPoint) || v.startPoint < 0 || v.startPoint >= points)
      throw new Error(`vehicles[${k}].startPoint 越界`);
    if (!isInt(v.availableTime) || v.availableTime < 0)
      throw new Error(`vehicles[${k}].availableTime 必须为非负整数`);
  });
  if (!Array.isArray(orders)) throw new Error("orders 必须为数组");
  if (orders.length > MAX_ORDERS)
    throw new Error(`订单数 ${orders.length} 超过上限 ${MAX_ORDERS}`);
  const oids = new Set<string>();
  orders.forEach((o, k) => {
    if (typeof o.id !== "string" || o.id.length === 0)
      throw new Error(`orders[${k}].id 必须为非空字符串`);
    if (oids.has(o.id)) throw new Error(`订单 id 重复: ${o.id}`);
    oids.add(o.id);
    for (const f of ["pickup", "delivery"] as const) {
      if (!isInt(o[f]) || o[f] < 0 || o[f] >= points)
        throw new Error(`orders[${k}].${f} 越界`);
    }
    if (!isInt(o.readyTime) || o.readyTime < 0)
      throw new Error(`orders[${k}].readyTime 必须为非负整数`);
    if (!isInt(o.deadline) || o.deadline < 0)
      throw new Error(`orders[${k}].deadline 必须为非负整数`);
    if (!isInt(o.serviceTime) || o.serviceTime < 0)
      throw new Error(`orders[${k}].serviceTime 必须为非负整数`);
    if (!isInt(o.revenue)) throw new Error(`orders[${k}].revenue 必须为整数`);
  });
}
