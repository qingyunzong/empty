export type PartitionId = string;

export interface DataEvent {
  type: 'data';
  partition: PartitionId;
  timestamp: number;
}

export interface IdleEvent {
  type: 'idle';
  partition: PartitionId;
}

export interface ActiveEvent {
  type: 'active';
  partition: PartitionId;
}

export type StreamEvent = DataEvent | IdleEvent | ActiveEvent;

export type RejectionReason =
  | 'late-data-below-partition-watermark'
  | 'data-before-published-watermark'
  | 'recovery-behind-published-watermark';

export interface Rejection {
  eventIndex: number;
  event: StreamEvent;
  reason: RejectionReason;
  publishedWatermark: number | null;
}

export interface WatermarkPoint {
  sequence: number;
  watermark: number;
  cause: { eventIndex: number; event: StreamEvent };
}

export type PartitionStatus = 'active' | 'idle';

export interface PartitionState {
  id: PartitionId;
  status: PartitionStatus;
  watermark: number | null;
}

export interface ReplayResult {
  trajectory: WatermarkPoint[];
  rejections: Rejection[];
  finalWatermark: number | null;
  partitions: PartitionState[];
  monotonic: boolean;
}
