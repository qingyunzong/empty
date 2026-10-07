import { Ack, DetectorConfig, IgnoredAck, Status, Transition } from "./types";

export class Detector {
  readonly config: DetectorConfig;
  status: Status = "ALIVE";
  heartbeat = 0;
  generation = 0;
  generationStartTick = 0;
  lastValidAckTick = 0;
  suspicionDeadline: number | null = null;
  readonly transitions: Transition[] = [];
  readonly ignoredAcks: IgnoredAck[] = [];

  constructor(config: DetectorConfig) {
    this.config = config;
  }

  startProbe(tick: number): void {
    this.generation += 1;
    this.generationStartTick = tick;
  }

  receiveAck(tick: number, ack: Ack): boolean {
    if (this.status === "DEAD") {
      this.ignoredAcks.push({
        tick,
        ack,
        reason: "node already DEAD; detector no longer accepts acks",
      });
      return false;
    }
    if (ack.generation !== this.generation) {
      this.ignoredAcks.push({
        tick,
        ack,
        reason: `stale generation ${ack.generation} (current ${this.generation}); old replies cannot clear suspicion`,
      });
      return false;
    }
    if (ack.heartbeat <= this.heartbeat) {
      this.ignoredAcks.push({
        tick,
        ack,
        reason: `old heartbeat ${ack.heartbeat} <= applied ${this.heartbeat}; cannot refresh`,
      });
      return false;
    }
    this.heartbeat = ack.heartbeat;
    this.lastValidAckTick = tick;
    this.suspicionDeadline = null;
    if (this.status !== "ALIVE") {
      this.transition(
        tick,
        "ALIVE",
        `valid ack (generation ${ack.generation}, heartbeat ${ack.heartbeat}) cleared ${this.status.toLowerCase()}`,
      );
    }
    return true;
  }

  evaluateTimeouts(tick: number): void {
    if (
      this.status === "ALIVE" &&
      tick - this.lastValidAckTick >= this.config.suspectTimeout
    ) {
      this.suspicionDeadline = tick + this.config.suspicionTimeout;
      this.transition(
        tick,
        "SUSPECT",
        `no valid ack for ${this.config.suspectTimeout} ticks (last valid ack at tick ${this.lastValidAckTick}); suspicion deadline ${this.suspicionDeadline}`,
      );
      return;
    }
    if (
      this.status === "SUSPECT" &&
      this.suspicionDeadline !== null &&
      tick >= this.suspicionDeadline
    ) {
      this.transition(
        tick,
        "DEAD",
        `suspicion deadline ${this.suspicionDeadline} reached without a valid ack`,
      );
    }
  }

  private transition(tick: number, to: Status, reason: string): void {
    const from = this.status;
    this.status = to;
    this.transitions.push({ tick, from, to, reason });
  }
}
