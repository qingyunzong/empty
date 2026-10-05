import type { EquipmentId, MaterialId, OrderId, StagePlan } from "./model";

/** 领域事件。顺序显式：落库时由 store 赋予连续序号 seq（1 起，步进 1）。 */
export type Event =
  | { kind: "StockReceived"; material: MaterialId; qty: number }
  | { kind: "EquipmentRegistered"; equipment: EquipmentId }
  | { kind: "OrderPlaced"; order: OrderId; stages: StagePlan[] }
  | { kind: "StageStarted"; order: OrderId; stage: string }
  | { kind: "StageCompleted"; order: OrderId; stage: string }
  | { kind: "StageFailed"; order: OrderId; stage: string }
  | { kind: "StageRetried"; order: OrderId; stage: string }
  | { kind: "OrderCancelled"; order: OrderId };

export type SequencedEvent = Event & { seq: number };
