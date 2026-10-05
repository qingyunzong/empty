import type { JobSpec, MaterialQty } from './state.js';

/**
 * 显式有序事件流：每个事件携带 seq（从 1 开始连续编号），
 * 重放时校验顺序，乱序即拒绝。
 */
export type EventPayload =
  | { type: 'StockInitialized'; items: MaterialQty }
  | { type: 'EquipmentRegistered'; equipmentId: string; capacity: number }
  | { type: 'OrderPlaced'; orderId: string; jobs: JobSpec[] }
  | { type: 'MaterialsReserved'; orderId: string; jobId: string; stageId: string; attempt: number; reserved: MaterialQty; fromRetained: MaterialQty }
  | { type: 'EquipmentOccupied'; jobId: string; stageId: string; units: MaterialQty }
  | { type: 'StageStarted'; jobId: string; stageId: string; attempt: number }
  | { type: 'StageCompleted'; jobId: string; stageId: string; attempt: number; consumed: MaterialQty }
  | { type: 'StageFailed'; jobId: string; stageId: string; attempt: number; reason: string }
  | { type: 'MaterialsRetained'; jobId: string; stageId: string; items: MaterialQty }
  | { type: 'MaterialsScrapped'; jobId: string; stageId: string; items: MaterialQty }
  | { type: 'EquipmentReleased'; jobId: string; stageId: string; units: MaterialQty }
  | { type: 'JobRetried'; jobId: string; attempt: number }
  | { type: 'JobCompleted'; jobId: string }
  | { type: 'OrderCompleted'; orderId: string }
  | { type: 'OrderCancelled'; orderId: string }
  | { type: 'JobCancelled'; orderId: string; jobId: string }
  | { type: 'MaterialsReturned'; orderId: string; jobId: string; items: MaterialQty; reason: 'order-cancel' };

export type Event = EventPayload & { seq: number };
