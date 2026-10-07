export type Status = "ALIVE" | "SUSPECT" | "DEAD";

export interface Ack {
  generation: number;
  heartbeat: number;
}

export interface Transition {
  tick: number;
  from: Status;
  to: Status;
  reason: string;
}

export interface IgnoredAck {
  tick: number;
  ack: Ack;
  reason: string;
}

export interface DetectorConfig {
  suspectTimeout: number;
  suspicionTimeout: number;
}
