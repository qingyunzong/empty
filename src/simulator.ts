import {
  acquireLock,
  createWorld,
  pickItem,
  placeItem,
  releaseLock,
  verifyWorld,
} from './model.js';
import type {
  ActionDef,
  ArmId,
  ItemId,
  SegmentId,
  Step,
  WorldConfig,
  WorldState,
} from './model.js';
import { WaitGraph } from './waitgraph.js';

export type EventBody =
  | { type: 'action_started'; action: string; arm: ArmId }
  | { type: 'action_completed'; action: string; arm: ArmId }
  | { type: 'action_failed'; action: string; arm: ArmId; reason: string }
  | { type: 'acquired'; arm: ArmId; segment: SegmentId }
  | { type: 'released'; arm: ArmId; segment: SegmentId; cause: 'step' | 'rollback' }
  | { type: 'picked'; arm: ArmId; item: ItemId; segment: SegmentId; cause: 'step' | 'rollback' }
  | { type: 'placed'; arm: ArmId; item: ItemId; segment: SegmentId; cause: 'step' | 'rollback' }
  | { type: 'blocked'; arm: ArmId; segment: SegmentId; holders: ArmId[] }
  | { type: 'unblocked'; arm: ArmId; segment: SegmentId }
  | { type: 'deadlock'; cycle: ArmId[]; dot: string }
  | { type: 'snapshot'; label: string };

export type SimEvent = EventBody & { seq: number; tick: number };

export interface ActionResult {
  action: string;
  arm: ArmId;
  ok: boolean;
  reason?: string;
}

interface ActionRuntime {
  def: ActionDef;
  cursor: number;
  done: Step[]; // completed steps, rolled back in reverse order on failure
  status: 'running' | 'blocked';
  blockedOn: SegmentId | null;
}

export interface SimOptions {
  /** verify item-uniqueness and resource-conservation after every event */
  validateEachEvent?: boolean;
  /** hook fired after each event; may call sim.snapshot() for arbitrary snapshots */
  onEvent?: (event: SimEvent, sim: Simulator) => void;
}

export class Simulator {
  readonly state: WorldState;
  readonly events: SimEvent[] = [];
  readonly snapshots = new Map<string, { atSeq: number; state: WorldState }>();
  readonly waitGraph = new WaitGraph();
  private tick = 0;
  private readonly queues = new Map<ArmId, ActionDef[]>();
  private readonly running = new Map<ArmId, ActionRuntime>();
  private readonly finished: ActionResult[] = [];

  constructor(readonly config: WorldConfig, private readonly opts: SimOptions = {}) {
    this.state = createWorld(config);
    for (const armId of config.arms) this.queues.set(armId, []);
    const violations = verifyWorld(this.state);
    if (violations.length > 0) {
      throw new Error(`invalid initial world: ${violations.join('; ')}`);
    }
  }

  get results(): readonly ActionResult[] {
    return this.finished;
  }

  get currentTick(): number {
    return this.tick;
  }

  submit(action: ActionDef): void {
    const queue = this.queues.get(action.arm);
    if (!queue) throw new Error(`submit: unknown arm ${action.arm}`);
    queue.push(action);
  }

  /** Save a full state snapshot at the current event position. */
  snapshot(label: string): void {
    if (this.snapshots.has(label)) throw new Error(`duplicate snapshot label ${label}`);
    this.emit({ type: 'snapshot', label });
    this.snapshots.set(label, {
      atSeq: this.events.length - 1,
      state: structuredClone(this.state),
    });
  }

  run(maxTicks = 10000): void {
    while (this.hasWork()) {
      if (this.tick >= maxTicks) throw new Error('max ticks exceeded');
      this.tick += 1;
      const eventsBefore = this.events.length;
      for (const armId of [...this.config.arms].sort()) {
        let rt = this.running.get(armId);
        if (!rt) {
          const queue = this.queues.get(armId);
          const def = queue && queue.length > 0 ? queue.shift() : undefined;
          if (!def) continue;
          rt = { def, cursor: 0, done: [], status: 'running', blockedOn: null };
          this.running.set(armId, rt);
          this.emit({ type: 'action_started', action: def.id, arm: armId });
        }
        if (rt.status === 'blocked') continue;
        this.stepOnce(armId, rt);
      }
      this.resolveDeadlocks();
      if (this.events.length === eventsBefore && this.hasWork()) {
        throw new Error('simulation stuck: no progress and no deadlock to resolve');
      }
    }
  }

  private hasWork(): boolean {
    if (this.running.size > 0) return true;
    for (const queue of this.queues.values()) if (queue.length > 0) return true;
    return false;
  }

  private emit(body: EventBody): void {
    const event = { ...body, seq: this.events.length, tick: this.tick } as SimEvent;
    this.events.push(event);
    if (this.opts.validateEachEvent) {
      const violations = verifyWorld(this.state);
      if (violations.length > 0) {
        throw new Error(
          `invariant violated after event #${event.seq} (${event.type}): ${violations.join('; ')}`,
        );
      }
    }
    this.opts.onEvent?.(event, this);
  }

  private stepOnce(armId: ArmId, rt: ActionRuntime): void {
    const arm = this.state.arms[armId];
    if (rt.cursor >= rt.def.steps.length) {
      if (arm.locks.length > 0) {
        this.failAction(armId, rt, `action ended while holding locks: ${arm.locks.join(', ')}`);
      } else {
        this.emit({ type: 'action_completed', action: rt.def.id, arm: armId });
        this.finished.push({ action: rt.def.id, arm: armId, ok: true });
        this.running.delete(armId);
      }
      return;
    }
    const step = rt.def.steps[rt.cursor];
    switch (step.kind) {
      case 'acquire': {
        const seg = this.state.segments[step.segment];
        if (!seg) {
          this.failAction(armId, rt, `unknown segment ${step.segment}`);
          return;
        }
        if (seg.holders.includes(armId)) {
          this.failAction(armId, rt, `segment ${step.segment} already locked by ${armId}`);
          return;
        }
        if (seg.holders.length >= seg.lockCapacity) {
          rt.status = 'blocked';
          rt.blockedOn = step.segment;
          this.emit({ type: 'blocked', arm: armId, segment: step.segment, holders: [...seg.holders] });
          return;
        }
        acquireLock(this.state, armId, step.segment);
        this.emit({ type: 'acquired', arm: armId, segment: step.segment });
        rt.done.push(step);
        rt.cursor += 1;
        return;
      }
      case 'release': {
        if (!arm.locks.includes(step.segment)) {
          this.failAction(armId, rt, `cannot release ${step.segment}: lock not held`);
          return;
        }
        releaseLock(this.state, armId, step.segment);
        this.emit({ type: 'released', arm: armId, segment: step.segment, cause: 'step' });
        rt.done.push(step);
        rt.cursor += 1;
        this.wakeWaiters(step.segment);
        return;
      }
      case 'pick': {
        const seg = this.state.segments[step.segment];
        if (!seg) {
          this.failAction(armId, rt, `unknown segment ${step.segment}`);
          return;
        }
        if (!arm.locks.includes(step.segment)) {
          this.failAction(armId, rt, `cannot pick on ${step.segment}: lock not held`);
          return;
        }
        if (arm.heldItem !== null) {
          this.failAction(armId, rt, `cannot pick ${step.item}: already holding ${arm.heldItem}`);
          return;
        }
        if (!seg.occupants.includes(step.item)) {
          this.failAction(armId, rt, `cannot pick ${step.item}: not on segment ${step.segment}`);
          return;
        }
        pickItem(this.state, armId, step.segment, step.item);
        this.emit({ type: 'picked', arm: armId, item: step.item, segment: step.segment, cause: 'step' });
        rt.done.push(step);
        rt.cursor += 1;
        return;
      }
      case 'place': {
        const seg = this.state.segments[step.segment];
        if (!seg) {
          this.failAction(armId, rt, `unknown segment ${step.segment}`);
          return;
        }
        if (!arm.locks.includes(step.segment)) {
          this.failAction(armId, rt, `cannot place on ${step.segment}: lock not held`);
          return;
        }
        if (arm.heldItem !== step.item) {
          this.failAction(armId, rt, `cannot place ${step.item}: not held`);
          return;
        }
        if (seg.occupants.length >= seg.capacity) {
          this.failAction(armId, rt, `cannot place ${step.item}: segment ${step.segment} full`);
          return;
        }
        placeItem(this.state, armId, step.segment, step.item);
        this.emit({ type: 'placed', arm: armId, item: step.item, segment: step.segment, cause: 'step' });
        rt.done.push(step);
        rt.cursor += 1;
        return;
      }
    }
  }

  private wakeWaiters(segment: SegmentId): void {
    for (const [armId, rt] of [...this.running.entries()].sort()) {
      if (rt.status === 'blocked' && rt.blockedOn === segment) {
        rt.status = 'running';
        rt.blockedOn = null;
        this.emit({ type: 'unblocked', arm: armId, segment });
      }
    }
  }

  private rebuildWaitGraph(): void {
    this.waitGraph.clear();
    for (const [armId, rt] of this.running) {
      if (rt.status === 'blocked' && rt.blockedOn !== null) {
        const seg = this.state.segments[rt.blockedOn];
        this.waitGraph.setEdges(armId, seg ? seg.holders : []);
      }
    }
  }

  private resolveDeadlocks(): void {
    for (;;) {
      this.rebuildWaitGraph();
      const cycle = this.waitGraph.findCycle();
      if (!cycle) return;
      const dot = this.waitGraph.toDot();
      this.emit({ type: 'deadlock', cycle, dot });
      const victim = cycle
        .slice(0, -1)
        .sort((a, b) => {
          const da = this.running.get(a)?.done.length ?? 0;
          const db = this.running.get(b)?.done.length ?? 0;
          return da - db || a.localeCompare(b);
        })[0];
      const rt = this.running.get(victim);
      if (!rt) throw new Error(`deadlock victim ${victim} has no running action`);
      rt.status = 'running';
      rt.blockedOn = null;
      this.failAction(victim, rt, `deadlock victim of cycle ${cycle.join(' -> ')}`);
    }
  }

  /**
   * Failure handling: undo completed steps in strict reverse order, so only
   * resources this action actually acquired are released (LIFO), and any
   * item it moved is carried back along the reverse path.
   */
  private failAction(armId: ArmId, rt: ActionRuntime, reason: string): void {
    this.emit({ type: 'action_failed', action: rt.def.id, arm: armId, reason });
    for (let i = rt.done.length - 1; i >= 0; i -= 1) {
      const step = rt.done[i];
      if (step.kind === 'acquire') {
        releaseLock(this.state, armId, step.segment);
        this.emit({ type: 'released', arm: armId, segment: step.segment, cause: 'rollback' });
        this.wakeWaiters(step.segment);
      } else if (step.kind === 'pick') {
        const arm = this.state.arms[armId];
        const seg = this.state.segments[step.segment];
        if (arm.heldItem !== step.item) {
          throw new Error(`rollback inconsistency: expected ${armId} to hold ${step.item}`);
        }
        if (seg.occupants.length >= seg.capacity) {
          throw new Error(`rollback inconsistency: no room to return ${step.item} to ${step.segment}`);
        }
        placeItem(this.state, armId, step.segment, step.item);
        this.emit({ type: 'placed', arm: armId, item: step.item, segment: step.segment, cause: 'rollback' });
      } else if (step.kind === 'place') {
        const seg = this.state.segments[step.segment];
        if (!seg.occupants.includes(step.item)) {
          throw new Error(`rollback inconsistency: ${step.item} no longer on ${step.segment}`);
        }
        pickItem(this.state, armId, step.segment, step.item);
        this.emit({ type: 'picked', arm: armId, item: step.item, segment: step.segment, cause: 'rollback' });
      }
      // 'release' steps are not undone: the resource is already gone.
    }
    this.finished.push({ action: rt.def.id, arm: armId, ok: false, reason });
    this.running.delete(armId);
  }
}
