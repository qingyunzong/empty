export type SegmentId = string;
export type ArmId = string;
export type ItemId = string;

/** One step of an arm's job. acquire/release are the resource points. */
export type Command =
  | { kind: "acquire"; segment: SegmentId }
  | { kind: "release"; segment: SegmentId }
  | { kind: "move"; item: ItemId; from: SegmentId; to: SegmentId }
  | { kind: "fail"; reason?: string };

export type EventType =
  | "acquire"
  | "release"
  | "block"
  | "move"
  | "fail"
  | "rollback-release"
  | "job-done"
  | "deadlock";

export interface SimEvent {
  seq: number;
  tick: number;
  type: EventType;
  arm?: ArmId;
  segment?: SegmentId;
  item?: ItemId;
  from?: SegmentId;
  to?: SegmentId;
  reason?: string;
  cycle?: ArmId[];
}

export type ArmStatus = "running" | "blocked" | "done" | "failed";

export interface ArmSpec {
  id: ArmId;
  program: Command[];
}

export interface SimConfig {
  segments: SegmentId[];
  /** Initial placement: item -> segment it rests on. */
  items: Record<ItemId, SegmentId>;
  arms: ArmSpec[];
}
