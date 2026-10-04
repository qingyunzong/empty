import type { AsyncAuthorizer } from './authorizer';
import type { DataStore } from './store';
import type { Item, Message, MessageDraft, Policy, Subject } from './types';

interface CheckResult {
  item: Item;
  allowed: boolean;
}

export class SubscriptionLibrary {
  private policy: Policy;
  private policyVersion = 0;
  private readonly sessions = new Set<SubscriptionSession>();
  private readonly unsubscribeStore: () => void;

  constructor(
    private readonly store: DataStore,
    private readonly authorizer: AsyncAuthorizer,
    initialPolicy: Policy,
  ) {
    this.policy = initialPolicy;
    this.unsubscribeStore = store.onChange(() => this.reevaluateAll());
  }

  get currentPolicy(): Policy {
    return this.policy;
  }

  get currentPolicyVersion(): number {
    return this.policyVersion;
  }

  setPolicy(policy: Policy): void {
    this.policy = policy;
    this.policyVersion += 1;
    this.reevaluateAll();
  }

  subscribe(subject: Subject): SubscriptionSession {
    const session = new SubscriptionSession(this.store, this.authorizer, this, subject, () => {
      this.sessions.delete(session);
    });
    this.sessions.add(session);
    session.reevaluate();
    return session;
  }

  dispose(): void {
    this.unsubscribeStore();
    this.sessions.clear();
  }

  private reevaluateAll(): void {
    for (const session of this.sessions) {
      session.reevaluate();
    }
  }
}

export class SubscriptionSession {
  private visible = new Map<string, Item>();
  private generation = 0;
  private messageVersion = 0;
  private closed = false;
  readonly messages: Message[] = [];

  constructor(
    private readonly store: DataStore,
    private readonly authorizer: AsyncAuthorizer,
    private readonly library: SubscriptionLibrary,
    readonly subject: Subject,
    private readonly onClose: () => void,
  ) {}

  reevaluate(): void {
    if (this.closed) {
      return;
    }
    const generation = ++this.generation;
    const policy = this.library.currentPolicy;
    const policyVersion = this.library.currentPolicyVersion;
    const items = this.store.snapshot();
    void Promise.all(
      items.map(async (item): Promise<CheckResult> => {
        const allowed = await this.authorizer.check(policy, item, this.subject);
        return { item, allowed };
      }),
    ).then((results) => this.publish(generation, policyVersion, results));
  }

  private publish(generation: number, policyVersion: number, results: CheckResult[]): void {
    // Stale async query results are forbidden: only the latest generation may publish.
    if (this.closed || generation !== this.generation) {
      return;
    }
    const next = new Map<string, Item>();
    for (const { item, allowed } of results) {
      if (allowed) {
        next.set(item.id, item);
      }
    }

    // Revocation rule: deletions are always emitted before new data.
    for (const id of this.visible.keys()) {
      if (!next.has(id)) {
        this.emit({ kind: 'delete', generation, policyVersion, id });
      }
    }
    for (const [id, item] of next) {
      const previous = this.visible.get(id);
      if (previous === undefined || JSON.stringify(previous) !== JSON.stringify(item)) {
        this.emit({ kind: 'upsert', generation, policyVersion, item });
      }
    }
    this.visible = next;
  }

  private emit(draft: MessageDraft): void {
    this.messageVersion += 1;
    this.messages.push({ ...draft, version: this.messageVersion });
  }

  visibleIds(): string[] {
    return [...this.visible.keys()].sort();
  }

  close(): void {
    if (this.closed) {
      return;
    }
    this.closed = true;
    this.onClose();
  }
}
