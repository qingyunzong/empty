/** 下单渠道：标准 / 加急 等，区别在提前期与固定启单费。 */
export interface Channel {
  name: string;
  leadTime: number; // 下单日到货日的整数天数
  fixedCost: number; // 每次下单的固定启单费
}

/** 已公布订单（重规划时的调整基准）。 */
export interface PublishedOrder {
  day: number; // 到货日（0 起，相对规划窗口）
  channel: string; // 渠道名
  qty: number; // 已公布下单量
  locked: number; // 其中已锁定、不可撤销的部分（0 <= locked <= qty）
}

export interface WarehouseInput {
  id: string;
  capacity: number; // 仓容（期末库存上限），各仓独立
  initialInventory: number; // 第 0 天期初库存
  holdingCost: number; // 单位期末库存 / 天的持有费
  demand: number[]; // 逐日需求，长度 = horizon（至多 12 天）
  channels: Channel[];
  published?: PublishedOrder[]; // 重规划时给出
}

export interface Scenario {
  horizon: number; // 1..12
  warehouses: WarehouseInput[];
}

export interface OrderDecision {
  day: number; // 到货日
  channel: string;
  qty: number;
  placeDay: number; // 下单日 = day - leadTime，负数表示规划窗口前已发出（在途）
}

export interface DayRecord {
  day: number;
  startInventory: number;
  arrivals: { channel: string; qty: number }[];
  demand: number;
  endInventory: number;
  holdingCost: number;
}

export interface WarehousePlan {
  warehouseId: string;
  orders: OrderDecision[];
  days: DayRecord[];
  orderingCost: number; // 启单费合计
  holdingCostTotal: number; // 持有费合计
  totalCost: number;
  deviation: number; // 与已公布下单量的总绝对偏差（仅重规划有意义）
}
