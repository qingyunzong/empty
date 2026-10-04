/**
 * In-memory browser lock manager.
 *
 * Semantics (mirroring a single-browser Web Locks style service):
 * - Locks are granted strictly in request (FIFO) order per resource.
 * - A page crash releases every lock it holds and every request it waits on.
 * - Recovery under the same page id starts a new generation; messages sent
 *   by an older generation (e.g. a release that was in flight when the page
 *   crashed) are rejected as stale.
 * - Every state transition is validated against the mutual-exclusion
 *   invariant and recorded as a step in an audit log.
 */

export type PageId = string;
export type ResourceName = string;

export interface RequestMessage {
  kind: "request";
  clock: number;
  pageId: PageId;
  generation: number;
  resource: ResourceName;
}

export interface ReleaseMessage {
  kind: "release";
  clock: number;
  pageId: PageId;
  generation: number;
  resource: ResourceName;
}

export interface CrashMessage {
  kind: "crash";
  clock: number;
  pageId: PageId;
}

export interface RecoverMessage {
  kind: "recover";
  clock: number;
  pageId: PageId;
}

export type LockMessage =
  | RequestMessage
  | ReleaseMessage
  | CrashMessage
  | RecoverMessage;

export type StepOutcome =
  | "granted"
  | "queued"
  | "released"
  | "crashed"
  | "recovered"
  | "rejected-stale"
  | "rejected-unknown-page"
  | "rejected-not-holder"
  | "rejected-not-held";

export interface StepRecord {
  step: number;
  message: LockMessage;
  outcome: StepOutcome;
  /** resource -> holder page id, snapshot after the step */
  ownership: Record<ResourceName, PageId>;
  /** resource -> queued "pageId#gen" in FIFO order, snapshot after the step */
  queues: Record<ResourceName, string[]>;
  /** mutual-exclusion invariant held after this step */
  mutexOk: boolean;
  note?: string;
}

interface PageState {
  generation: number;
  alive: boolean;
}

interface ResourceState {
  holder: PageId | null;
  queue: PageId[];
}

export class LockManager {
  private pages = new Map<PageId, PageState>();
  private resources = new Map<ResourceName, ResourceState>();
  private heldBy = new Map<PageId, Set<ResourceName>>();
  readonly log: StepRecord[] = [];

  apply(message: LockMessage): StepRecord {
    let outcome: StepOutcome;
    let note: string | undefined;

    switch (message.kind) {
      case "request":
        [outcome, note] = this.applyRequest(message);
        break;
      case "release":
        [outcome, note] = this.applyRelease(message);
        break;
      case "crash":
        [outcome, note] = this.applyCrash(message);
        break;
      case "recover":
        [outcome, note] = this.applyRecover(message);
        break;
    }

    const mutexOk = this.checkInvariants();
    const record: StepRecord = {
      step: this.log.length + 1,
      message,
      outcome,
      ownership: this.ownershipSnapshot(),
      queues: this.queueSnapshot(),
      mutexOk,
    };
    if (note !== undefined) record.note = note;
    this.log.push(record);
    return record;
  }

  /** Ownership snapshot: resource -> current holder. */
  ownershipSnapshot(): Record<ResourceName, PageId> {
    const out: Record<ResourceName, PageId> = {};
    for (const [name, state] of [...this.resources.entries()].sort()) {
      if (state.holder !== null) out[name] = state.holder;
    }
    return out;
  }

  /** Waiting-queue snapshot: resource -> FIFO list of "pageId#generation". */
  queueSnapshot(): Record<ResourceName, string[]> {
    const out: Record<ResourceName, string[]> = {};
    for (const [name, state] of [...this.resources.entries()].sort()) {
      if (state.queue.length > 0) {
        out[name] = state.queue.map(
          (id) => `${id}#${this.pages.get(id)?.generation ?? "?"}`,
        );
      }
    }
    return out;
  }

  /**
   * Mutual-exclusion and structural invariants. Returns true when all hold:
   * 1. each resource has at most one holder;
   * 2. the holder never appears in its own queue and no page queues twice;
   * 3. holder/waiter bookkeeping is consistent in both directions;
   * 4. only live pages hold or wait for locks.
   */
  checkInvariants(): boolean {
    for (const [, state] of this.resources) {
      if (state.holder !== null && state.queue.includes(state.holder)) {
        return false; // holder also waiting on the same resource
      }
      if (new Set(state.queue).size !== state.queue.length) {
        return false; // duplicate waiter
      }
      if (state.holder !== null) {
        const held = this.heldBy.get(state.holder);
        if (held === undefined) return false;
      }
      for (const waiter of state.queue) {
        if (!this.pages.get(waiter)?.alive) return false; // dead page waiting
      }
      if (state.holder !== null && !this.pages.get(state.holder)?.alive) {
        return false; // dead page holding
      }
    }
    for (const [pageId, held] of this.heldBy) {
      for (const name of held) {
        if (this.resources.get(name)?.holder !== pageId) return false;
      }
    }
    return true;
  }

  private applyRequest(msg: RequestMessage): [StepOutcome, (string | undefined)?] {
    let page = this.pages.get(msg.pageId);
    if (page === undefined) {
      // First contact: the page registers implicitly with its claimed
      // generation; later generations are only established via recover.
      page = { generation: msg.generation, alive: true };
      this.pages.set(msg.pageId, page);
      this.heldBy.set(msg.pageId, new Set());
    }
    if (msg.generation !== page.generation) return ["rejected-stale"];
    if (!page.alive) return ["rejected-stale", "page is crashed"];

    const state = this.resourceOf(msg.resource);
    if (state.holder === null && state.queue.length === 0) {
      state.holder = msg.pageId;
      this.heldSetOf(msg.pageId).add(msg.resource);
      return ["granted"];
    }
    if (state.holder === msg.pageId || state.queue.includes(msg.pageId)) {
      return ["rejected-stale", "duplicate request for same resource"];
    }
    state.queue.push(msg.pageId);
    return ["queued"];
  }

  private applyRelease(msg: ReleaseMessage): [StepOutcome, (string | undefined)?] {
    const page = this.pages.get(msg.pageId);
    if (page === undefined) return ["rejected-unknown-page"];
    if (msg.generation !== page.generation) {
      return [
        "rejected-stale",
        `release from generation ${msg.generation}, current is ${page.generation}`,
      ];
    }
    const state = this.resources.get(msg.resource);
    if (state === undefined || state.holder !== msg.pageId) {
      return ["rejected-not-holder"];
    }
    this.heldSetOf(msg.pageId).delete(msg.resource);
    state.holder = null;
    const note = this.grantNext(msg.resource, state);
    return ["released", note];
  }

  private applyCrash(msg: CrashMessage): [StepOutcome, (string | undefined)?] {
    const page = this.pages.get(msg.pageId);
    if (page === undefined) return ["rejected-unknown-page"];
    page.alive = false;

    const released: string[] = [];
    for (const name of this.heldSetOf(msg.pageId)) {
      const state = this.resources.get(name);
      if (state !== undefined && state.holder === msg.pageId) {
        state.holder = null;
        released.push(name);
      }
    }
    this.heldBy.set(msg.pageId, new Set());

    const dequeued: string[] = [];
    for (const [name, state] of this.resources) {
      const before = state.queue.length;
      state.queue = state.queue.filter((id) => id !== msg.pageId);
      if (state.queue.length < before) dequeued.push(name);
    }

    for (const name of released) {
      this.grantNext(name, this.resourceOf(name));
    }
    const parts: string[] = [];
    if (released.length > 0) parts.push(`released held: ${released.join(",")}`);
    if (dequeued.length > 0) parts.push(`dropped waiting: ${dequeued.join(",")}`);
    return ["crashed", parts.length > 0 ? parts.join("; ") : "nothing held or pending"];
  }

  private applyRecover(msg: RecoverMessage): [StepOutcome, (string | undefined)?] {
    const page = this.pages.get(msg.pageId);
    if (page !== undefined && page.alive) {
      return ["rejected-stale", "recover while page still alive"];
    }
    const generation = (page?.generation ?? 0) + 1;
    this.pages.set(msg.pageId, { generation, alive: true });
    if (!this.heldBy.has(msg.pageId)) this.heldBy.set(msg.pageId, new Set());
    return ["recovered", `new generation ${generation}`];
  }

  /** Grant a free resource to the head of its FIFO queue, if any. */
  private grantNext(name: ResourceName, state: ResourceState): string | undefined {
    if (state.holder !== null) return undefined;
    const next = state.queue.shift();
    if (next === undefined) return undefined;
    state.holder = next;
    this.heldSetOf(next).add(name);
    return `granted to next waiter ${next}`;
  }

  private resourceOf(name: ResourceName): ResourceState {
    let state = this.resources.get(name);
    if (state === undefined) {
      state = { holder: null, queue: [] };
      this.resources.set(name, state);
    }
    return state;
  }

  private heldSetOf(pageId: PageId): Set<ResourceName> {
    let set = this.heldBy.get(pageId);
    if (set === undefined) {
      set = new Set();
      this.heldBy.set(pageId, set);
    }
    return set;
  }
}
