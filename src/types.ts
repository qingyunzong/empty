export type Tick = number;

export interface ObservationEvent {
  kind: "observation";
  tick: Tick;
  value: number;
}

export interface CorrectionEvent {
  kind: "correction";
  tick: Tick;
  value: number;
}

export interface MissingEvent {
  kind: "missing";
  tick: Tick;
}

export type SeriesEvent = ObservationEvent | CorrectionEvent | MissingEvent;

export type BreakReason =
  | "below-threshold"
  | "missing"
  | "series-start"
  | "open";

export interface BoundaryEvidence {
  tick: Tick;
  value: number | null;
  reason: BreakReason;
}

export interface SampleEvidence {
  tick: Tick;
  value: number;
}

export interface AlertInterval {
  startTick: Tick;
  endTick: Tick;
  durationTicks: number;
  startEvidence: {
    sample: SampleEvidence;
    before: BoundaryEvidence;
  };
  endEvidence: {
    sample: SampleEvidence;
    after: BoundaryEvidence;
  };
}

export type AlertEvent =
  | { type: "raised"; alert: AlertInterval }
  | { type: "extended"; previousEnd: Tick; alert: AlertInterval }
  | { type: "retracted"; alert: AlertInterval };
