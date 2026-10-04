import type {
  ArmId,
  ArmSpec,
  ArmStatus,
  Command,
  ItemId,
  SegmentId,
  SimConfig,
  SimEvent,
} from "./model";
import { findCycle, formatGraph, toDot, type WaitEdge } from "./waitgraph";
import { replayEvents, type Snapshot } from "./snapshot";

interface SegmentState {
  item: ItemId | null;
  holder: ArmId | null;
  queue: ArmId[];
}

interface ArmState {
  id: ArmId;
  program: Command[];
  pc: number;
  held: SegmentId[];
  waitingFor: SegmentId | null;
  status: ArmStatus;
}

/**
 * Deterministic discrete-round simulator.
 * Each round, every running arm executes exactly one command, in arm order.
 * A blocked arm stays blocked until the segment it waits on is released.
 */
export class Simulator {
  readonly config: SimConfig;
  readonly events: SimEvent[] = [];
  tick = 0;

  private readonly segments = new Map<SegmentId, SegmentState>();
  private readonly arms = new Map<ArmId, ArmState>();
  private readonly items = new Map<ItemId, SegmentId>();

  constructor(config: SimConfig) {
    this.config = config;
    for (const id of config.segments) {
      this.segments.set(id, { item: null, holder: null, queue: [] });
    }
    for (const [item, seg] of Object.entries(config.items)) {
      const state = this.mustSegment(seg);
      if (state.item !== null) {
        throw new Error(`initial placement conflict on segment ${seg}`);
      }
      state.item = item;
      this.items.set(item, seg);
    }
    for (const spec of config.arms) {
      if (this.arms.has(spec.id)) throw new Error(`duplicate arm ${spec.id}`);
      this.arms.set(spec.id, {
        id: spec.id,
        program: spec.program,
        pc: 0,
        held: [],
        waitingFor: null,
        status: "running",
      });
    }
  }

  private mustSegment(id: SegmentId): SegmentState {
    const seg = this.segments.get(id);
    if (!seg) throw new Error(`unknown segment ${id}`);
    return seg;
  }

  private log(event: Omit<SimEvent, "seq" | "tick">): void {
    this.events.push({ seq: this.events.length, tick: this.tick, ...event });
  }

  armStatus(id: ArmId): ArmStatus {
    const arm = this.arms.get(id);
    if (!arm) throw new Error(`unknown arm ${id}`);
    return arm.status;
  }

  itemAt(item: ItemId): SegmentId | undefined {
    return this.items.get(item);
  }

  /** Current wait-for edges: blocked arm -> arm holding the wanted segment. */
  waitForEdges(): WaitEdge[] {
    const edges: WaitEdge[] = [];
    for (const arm of this.arms.values()) {
      if (arm.status === "blocked" && arm.waitingFor !== null) {
        const holder = this.mustSegment(arm.waitingFor).holder;
        if (holder !== null && holder !== arm.id) edges.push([arm.id, holder]);
      }
    }
    return edges;
  }

  waitGraphText(): string {
    return formatGraph(this.waitForEdges(), findCycle(this.waitForEdges()));
  }

  waitGraphDot(): string {
    return toDot(this.waitForEdges(), findCycle(this.waitForEdges()));
  }

  private exec(arm: ArmState, cmd: Command): void {
    switch (cmd.kind) {
      case "acquire": {
        const seg = this.mustSegment(cmd.segment);
        if (seg.holder === null) {
          seg.holder = arm.id;
          arm.held.push(cmd.segment);
          arm.pc++;
          this.log({ type: "acquire", arm: arm.id, segment: cmd.segment });
        } else {
          arm.status = "blocked";
          arm.waitingFor = cmd.segment;
          seg.queue.push(arm.id);
          this.log({ type: "block", arm: arm.id, segment: cmd.segment });
        }
        return;
      }
      case "release": {
        if (!arm.held.includes(cmd.segment)) {
          this.failArm(arm, `release of unheld segment ${cmd.segment}`);
          return;
        }
        this.releaseSegment(arm, cmd.segment, "release");
        arm.pc++;
        return;
      }
      case "move": {
        const from = this.mustSegment(cmd.from);
        const to = this.mustSegment(cmd.to);
        const problems: string[] = [];
        if (this.items.get(cmd.item) !== cmd.from) {
          problems.push(`item ${cmd.item} is not on ${cmd.from}`);
        }
        if (to.item !== null) problems.push(`segment ${cmd.to} is occupied`);
        if (!arm.held.includes(cmd.to)) {
          problems.push(`arm does not hold target segment ${cmd.to}`);
        }
        if (problems.length > 0) {
          this.failArm(arm, `move ${cmd.item} ${cmd.from}->${cmd.to}: ${problems.join("; ")}`);
          return;
        }
        from.item = null;
        to.item = cmd.item;
        this.items.set(cmd.item, cmd.to);
        arm.pc++;
        this.log({ type: "move", arm: arm.id, item: cmd.item, from: cmd.from, to: cmd.to });
        return;
      }
      case "fail": {
        this.failArm(arm, cmd.reason ?? "injected failure");
        return;
      }
    }
  }

  private releaseSegment(
    arm: ArmState,
    segmentId: SegmentId,
    type: "release" | "rollback-release",
  ): void {
    const seg = this.mustSegment(segmentId);
    seg.holder = null;
    arm.held = arm.held.filter((s) => s !== segmentId);
    this.log({ type, arm: arm.id, segment: segmentId });
    const next = seg.queue.shift();
    if (next !== undefined) {
      const waiter = this.arms.get(next);
      if (waiter && waiter.status === "blocked" && waiter.waitingFor === segmentId) {
        seg.holder = waiter.id;
        waiter.held.push(segmentId);
        waiter.waitingFor = null;
        waiter.status = "running";
        waiter.pc++;
        this.log({ type: "acquire", arm: waiter.id, segment: segmentId });
      }
    }
  }

  /** Failure handling: release only the resources this arm acquired, in reverse (LIFO) order. */
  private failArm(arm: ArmState, reason: string): void {
    this.log({ type: "fail", arm: arm.id, reason });
    for (let i = arm.held.length - 1; i >= 0; i--) {
      this.releaseSegment(arm, arm.held[i], "rollback-release");
    }
    arm.status = "failed";
    arm.pc = arm.program.length;
  }

  /** One round: each running arm executes one command. */
  step(): void {
    for (const arm of this.arms.values()) {
      if (arm.status !== "running") continue;
      if (arm.pc >= arm.program.length) {
        if (arm.held.length > 0) {
          this.failArm(arm, "program ended while still holding segments");
        } else {
          arm.status = "done";
          this.log({ type: "job-done", arm: arm.id });
        }
        continue;
      }
      this.exec(arm, arm.program[arm.pc]);
    }
    this.tick++;
  }

  /** Run until every arm is done/failed, or only blocked arms remain (deadlock). */
  run(maxTicks = 10000): void {
    while (this.tick < maxTicks) {
      const active = [...this.arms.values()].filter(
        (a) => a.status === "running" || a.status === "blocked",
      );
      if (active.length === 0) return;
      if (active.every((a) => a.status === "blocked")) {
        const edges = this.waitForEdges();
        const cycle = findCycle(edges);
        this.log({
          type: "deadlock",
          cycle: cycle ?? active.map((a) => a.id),
          reason: cycle
            ? `circular wait: ${cycle.join(" -> ")}`
            : "all remaining arms blocked",
        });
        return;
      }
      this.step();
    }
    throw new Error(`simulation did not terminate within ${maxTicks} ticks`);
  }

  /** Deep-copied snapshot of the current state. */
  snapshot(): Snapshot {
    const segments: Snapshot["segments"] = {};
    for (const [id, seg] of this.segments) {
      segments[id] = { item: seg.item, holder: seg.holder, queue: [...seg.queue] };
    }
    const arms: Snapshot["arms"] = {};
    for (const [id, arm] of this.arms) {
      arms[id] = { status: arm.status, held: [...arm.held], waitingFor: arm.waitingFor };
    }
    const items: Snapshot["items"] = {};
    for (const [item, seg] of this.items) items[item] = seg;
    return {
      atEvent: this.events.length - 1,
      tick: this.tick,
      items,
      segments,
      arms,
    };
  }

  /** Reconstruct the state right after event `seq` by replaying the log. */
  snapshotAtEvent(seq: number): Snapshot {
    return replayEvents(this.config, this.events, seq).snapshot;
  }
}

export function makeArm(id: ArmId, program: Command[]): ArmSpec {
  return { id, program };
}
