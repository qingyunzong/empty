// Snapshot interpreter: an independent, deliberately naive reference
// implementation of the publish semantics, used as the executable spec that
// the real EventBus is checked against. Plain recursion, no AsyncLocalStorage,
// no invocation scopes.

export class InterpreterAggregate extends AggregateError {
  constructor(errors: readonly unknown[]) {
    super(errors, `interpreter: ${errors.length} error(s)`);
  }
}

interface InterpreterSubscription {
  readonly id: number;
  readonly name: string;
  readonly fn: (payload: string) => void;
}

interface ChildEntry {
  readonly log: LogEntry[];
  aggregate: InterpreterAggregate | null;
}

type LogEntry =
  | { readonly kind: 'error'; readonly error: unknown }
  | { readonly kind: 'child'; readonly child: ChildEntry };

function flatten(log: readonly LogEntry[]): unknown[] {
  const merged: unknown[] = [];
  for (const entry of log) {
    if (entry.kind === 'error') merged.push(entry.error);
    else merged.push(...flatten(entry.child.log));
  }
  return merged;
}

export class SnapshotInterpreter {
  private readonly registry = new Map<string, Map<number, InterpreterSubscription>>();
  private readonly topics = new Map<number, string>();
  private readonly logStack: LogEntry[][] = [];
  private nextId = 1;
  readonly trace: string[] = [];

  subscribe(topic: string, name: string, fn: (payload: string) => void): number {
    const id = this.nextId++;
    let bucket = this.registry.get(topic);
    if (bucket === undefined) {
      bucket = new Map();
      this.registry.set(topic, bucket);
    }
    bucket.set(id, { id, name, fn });
    this.topics.set(id, topic);
    return id;
  }

  unsubscribe(id: number): void {
    const topic = this.topics.get(id);
    if (topic === undefined) return;
    this.topics.delete(id);
    const bucket = this.registry.get(topic);
    if (bucket !== undefined) {
      bucket.delete(id);
      if (bucket.size === 0) this.registry.delete(topic);
    }
  }

  publish(topic: string, payload: string): void {
    const log: LogEntry[] = [];
    const childEntry: ChildEntry = { log, aggregate: null };
    const parentLog = this.logStack[this.logStack.length - 1];
    if (parentLog !== undefined) parentLog.push({ kind: 'child', child: childEntry });
    this.logStack.push(log);
    // Fixed snapshot: mutations during dispatch only affect later publishes.
    const snapshot = [...(this.registry.get(topic)?.values() ?? [])];
    try {
      for (const subscription of snapshot) {
        this.trace.push(`call:${subscription.name}:${payload}`);
        try {
          subscription.fn(payload);
        } catch (error) {
          // An aggregate re-thrown from a derived publish is already merged
          // at the derived publish's own position in this log.
          if (!this.isChildAggregate(log, error)) {
            log.push({ kind: 'error', error });
          }
        }
      }
    } finally {
      this.logStack.pop();
    }
    const merged = flatten(log);
    if (merged.length > 0) {
      childEntry.aggregate = new InterpreterAggregate(merged);
      throw childEntry.aggregate;
    }
  }

  private isChildAggregate(log: readonly LogEntry[], error: unknown): boolean {
    return log.some(
      (entry) => entry.kind === 'child' && entry.child.aggregate === error,
    );
  }
}
