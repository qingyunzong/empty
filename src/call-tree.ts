import { immediateScheduler, type Scheduler } from "./scheduler.js";

/**
 * A CallTree caps the number of in-flight function executions across an
 * entire (arbitrarily nested) call tree. Every frame of the tree shares
 * this single budget, no matter how deep the nesting goes.
 *
 * Slot accounting rules:
 * - a frame must hold a slot while its function body is running;
 * - a frame awaiting a child (ctx.spawn) yields its slot, and must
 *   re-acquire one before its continuation resumes;
 * - slots are handed to waiters in FIFO order through the scheduler;
 * - every exit path (return or throw) releases the frame's slot, so an
 *   exception unwinds the tree with zero slots left held.
 */
export class CallTree {
  private inFlightCount = 0;
  private readonly waiters: Array<() => void> = [];
  private acquireCount = 0;
  private maxObservedCount = 0;

  constructor(
    readonly capacity: number,
    private readonly scheduler: Scheduler = immediateScheduler,
  ) {
    if (!Number.isInteger(capacity) || capacity < 1) {
      throw new RangeError("capacity must be a positive integer");
    }
  }

  /** Slots currently held by running frames. */
  get inFlight(): number {
    return this.inFlightCount;
  }

  /** Acquire calls still queued for a slot. */
  get waiting(): number {
    return this.waiters.length;
  }

  /** High-water mark of inFlight; must never exceed capacity. */
  get maxObserved(): number {
    return this.maxObservedCount;
  }

  /** Total successful acquires, including re-acquires on resume. */
  get totalAcquires(): number {
    return this.acquireCount;
  }

  acquire(): Promise<void> {
    if (this.waiters.length === 0 && this.inFlightCount < this.capacity) {
      this.enter();
      return Promise.resolve();
    }
    return new Promise<void>((resolve) => {
      this.waiters.push(resolve);
    });
  }

  release(): void {
    if (this.inFlightCount <= 0) {
      throw new Error("release without a matching acquire");
    }
    const next = this.waiters.shift();
    if (next !== undefined) {
      // Hand the slot directly to the oldest waiter: inFlight stays the
      // same, so no new caller can barge in ahead of the queued grant.
      this.noteAcquire();
      this.scheduler.schedule(next);
    } else {
      this.inFlightCount -= 1;
    }
  }

  private enter(): void {
    this.inFlightCount += 1;
    this.noteAcquire();
  }

  private noteAcquire(): void {
    this.acquireCount += 1;
    if (this.inFlightCount > this.maxObservedCount) {
      this.maxObservedCount = this.inFlightCount;
    }
  }
}

export type TreeFn<T> = (ctx: TreeContext) => T | Promise<T>;

export interface TreeContext {
  readonly tree: CallTree;
  readonly depth: number;
  /** Runs fn as a child frame; the caller's slot is yielded while awaiting. */
  spawn<T>(fn: TreeFn<T>): Promise<T>;
}

/**
 * Per-frame slot bookkeeping. A frame owns at most one slot; the flag and
 * the serialized lock keep accounting exact even when a frame awaits
 * several children concurrently (e.g. Promise.all of spawns).
 */
class Frame {
  private holdsSlot = true;
  private slotLock: Promise<void> = Promise.resolve();
  private outstanding = 0;
  private onDrained: (() => void) | null = null;

  constructor(private readonly tree: CallTree) {}

  yieldSlot(): Promise<void> {
    return this.withSlotLock(() => {
      if (!this.holdsSlot) {
        return;
      }
      this.holdsSlot = false;
      this.tree.release();
    });
  }

  reacquireSlot(): Promise<void> {
    return this.withSlotLock(async () => {
      if (this.holdsSlot) {
        return;
      }
      await this.tree.acquire();
      this.holdsSlot = true;
    });
  }

  trackSpawn<T>(spawned: Promise<T>): Promise<T> {
    this.outstanding += 1;
    const settled = (): void => {
      this.outstanding -= 1;
      if (this.outstanding === 0 && this.onDrained !== null) {
        this.onDrained();
      }
    };
    spawned.then(settled, settled);
    return spawned;
  }

  /** Resolves once every spawned child of this frame has settled. */
  quiesce(): Promise<void> {
    if (this.outstanding === 0) {
      return Promise.resolve();
    }
    return new Promise<void>((resolve) => {
      this.onDrained = resolve;
    });
  }

  /** Releases the frame slot if still held; idempotent. */
  releaseFinal(): Promise<void> {
    return this.withSlotLock(() => {
      if (!this.holdsSlot) {
        return;
      }
      this.holdsSlot = false;
      this.tree.release();
    });
  }

  private withSlotLock(op: () => void | Promise<void>): Promise<void> {
    const run = this.slotLock.then(op);
    this.slotLock = run.then(noop, noop);
    return run;
  }
}

function noop(): void {}

/** Runs fn as the root frame of a call tree bounded by tree.capacity. */
export function runTree<T>(tree: CallTree, fn: TreeFn<T>): Promise<T> {
  return exec(tree, fn, 0);
}

async function exec<T>(tree: CallTree, fn: TreeFn<T>, depth: number): Promise<T> {
  await tree.acquire();
  const frame = new Frame(tree);
  const ctx: TreeContext = {
    tree,
    depth,
    spawn: (child) => frame.trackSpawn(spawnChild(tree, frame, child, depth + 1)),
  };
  try {
    return await fn(ctx);
  } finally {
    // Wait for stragglers, then release: on return AND on throw the frame
    // leaves the tree with zero slots held.
    await frame.quiesce();
    await frame.releaseFinal();
  }
}

async function spawnChild<T>(
  tree: CallTree,
  parent: Frame,
  fn: TreeFn<T>,
  depth: number,
): Promise<T> {
  // The parent yields its slot while it awaits the child...
  await parent.yieldSlot();
  try {
    return await exec(tree, fn, depth);
  } finally {
    // ...and must re-acquire a slot before its continuation resumes,
    // whether the child resolved or threw.
    await parent.reacquireSlot();
  }
}
