/** 物料在账本中的桶（bucket）。所有数量守恒：各桶之和的变动必须等于收货减损耗。 */
export type Bucket = "onHand" | "held" | "retained" | "consumed" | "lost" | "reversed";

export type MaterialId = string;
export type EquipmentId = string;
export type OrderId = string;

/** 订单下达时确定的阶段计划：投料需求、占用设备、失败时各原料的可回收率。 */
export interface StagePlan {
  readonly name: string;
  readonly materials: Readonly<Record<MaterialId, number>>;
  readonly equipment: EquipmentId;
  readonly recovery: Readonly<Record<MaterialId, number>>;
}

export interface MaterialAccount {
  onHand: number;
  held: number;
  retained: number;
  consumed: number;
  lost: number;
  reversed: number;
}

export type StageStatus = "pending" | "in-progress" | "completed" | "failed";

export interface StageState {
  readonly name: string;
  status: StageStatus;
  readonly required: Record<MaterialId, number>;
  /** 失败回收后为该订单保留的原料，重试时优先抵扣、不再从库房消耗。 */
  retained: Record<MaterialId, number>;
  attempts: number;
}

export type OrderStatus = "open" | "completed" | "cancelled";

export interface OrderState {
  readonly id: OrderId;
  status: OrderStatus;
  readonly stages: StageState[];
}

export interface EquipmentState {
  readonly id: EquipmentId;
  busyBy: { order: OrderId; stage: string } | null;
}

/** 物料账分录：一笔物料从一个桶移动到另一个桶。 */
export interface LedgerEntry {
  seq: number;
  material: MaterialId;
  from: Bucket;
  to: Bucket;
  qty: number;
  reason: string;
  order: OrderId | null;
  stage: string | null;
}

export interface World {
  /** 已应用事件数，即下一个事件的期望序号（从 1 开始）。 */
  seq: number;
  materials: Record<MaterialId, MaterialAccount>;
  equipment: Record<EquipmentId, EquipmentState>;
  orders: Record<OrderId, OrderState>;
  plans: Record<OrderId, readonly StagePlan[]>;
  ledger: LedgerEntry[];
}

export function emptyAccount(): MaterialAccount {
  return { onHand: 0, held: 0, retained: 0, consumed: 0, lost: 0, reversed: 0 };
}

export function initialWorld(): World {
  return { seq: 0, materials: {}, equipment: {}, orders: {}, plans: {}, ledger: [] };
}
