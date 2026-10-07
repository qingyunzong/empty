import { Detector } from "./detector";
import { DetectorConfig, Status } from "./types";

export interface SimConfig extends DetectorConfig {
  probeInterval: number;
  maxDelay: number;
  dropRate: number;
  ticks: number;
}

export interface TickRecord {
  tick: number;
  status: Status;
  heartbeat: number;
  generation: number;
}

export interface SimEvent {
  tick: number;
  kind: "probe" | "ack";
  generation: number;
  heartbeat?: number;
}

export interface SimResult {
  detector: Detector;
  timeline: TickRecord[];
  events: SimEvent[];
}

export function runSimulation(cfg: SimConfig, rand: () => number): SimResult {
  const detector = new Detector(cfg);
  const events: SimEvent[] = [];
  const acks: { tick: number; generation: number; heartbeat: number }[] = [];
  let nodeHeartbeat = 0;

  for (let t = 0; t <= cfg.ticks; t += cfg.probeInterval) {
    const generation = t / cfg.probeInterval + 1;
    events.push({ tick: t, kind: "probe", generation });
    if (rand() >= cfg.dropRate) {
      nodeHeartbeat += 1;
      const delay = 1 + Math.floor(rand() * (cfg.maxDelay + 1));
      const ack = { tick: t + delay, generation, heartbeat: nodeHeartbeat };
      acks.push(ack);
      events.push({ tick: ack.tick, kind: "ack", generation, heartbeat: nodeHeartbeat });
    }
  }
  acks.sort((a, b) => a.tick - b.tick || a.heartbeat - b.heartbeat);

  const timeline: TickRecord[] = [];
  let nextAck = 0;
  for (let t = 0; t <= cfg.ticks; t++) {
    if (t % cfg.probeInterval === 0) {
      detector.startProbe(t);
    }
    while (nextAck < acks.length && acks[nextAck].tick === t) {
      detector.receiveAck(t, acks[nextAck]);
      nextAck += 1;
    }
    detector.evaluateTimeouts(t);
    timeline.push({
      tick: t,
      status: detector.status,
      heartbeat: detector.heartbeat,
      generation: detector.generation,
    });
  }

  return { detector, timeline, events };
}
