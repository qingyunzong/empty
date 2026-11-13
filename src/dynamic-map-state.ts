import {
  AggregateSnapshot,
  InvalidTransitionError,
  InvalidManifestError,
  Manifest,
  ManifestApplySummary,
  ManifestConflictError,
  MapStateEvent,
  SubtaskFailure,
  SubtaskResult,
  SubtaskStatus,
  UnknownSubtaskError,
} from "./types.js";

interface SubtaskRecord {
  status: SubtaskStatus;
  readonly addedIn: string;
  startedIn: string | null;
  detached: boolean;
}

type Listener<T> = (event: MapStateEvent<T>) => void;

const TERMINAL: ReadonlySet<SubtaskStatus> = new Set([
  "succeeded",
  "failed",
  "cancelled",
]);

function sameItems(a: readonly string[], b: readonly string[]): boolean {
  if (a.length !== b.length) return false;
  const set = new Set(a);
  return set.size === a.length && b.every((item) => set.has(item));
}

export class DynamicMapState<T = unknown> {
  private manifest: Manifest | null = null;
  private readonly subtasks = new Map<string, SubtaskRecord>();
  private readonly results = new Map<string, SubtaskResult<T>>();
  private readonly failures = new Map<string, SubtaskFailure>();
  private readonly listeners = new Set<Listener<T>>();
  private aggregatedForCurrent = false;

  subscribe(listener: Listener<T>): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private emit(event: MapStateEvent<T>): void {
    for (const listener of this.listeners) listener(event);
  }

  get currentVersion(): string | null {
    return this.manifest?.version ?? null;
  }

  statusOf(key: string): SubtaskStatus {
    return this.recordOf(key).status;
  }

  getResult(key: string): SubtaskResult<T> | undefined {
    return this.results.get(key);
  }

  getFailure(key: string): SubtaskFailure | undefined {
    return this.failures.get(key);
  }

  applyManifest(manifest: Manifest): ManifestApplySummary | null {
    if (this.manifest !== null && this.manifest.version === manifest.version) {
      if (!sameItems(this.manifest.items, manifest.items)) {
        throw new ManifestConflictError(manifest.version);
      }
      this.emit({ type: "manifest-ignored", version: manifest.version });
      return null;
    }

    const next = new Set(manifest.items);
    if (next.size !== manifest.items.length) {
      throw new InvalidManifestError(
        `manifest version "${manifest.version}" contains duplicate items`,
      );
    }

    const added: string[] = [];
    const cancelled: string[] = [];
    const detached: string[] = [];

    for (const [key, record] of this.subtasks) {
      if (next.has(key)) {
        if (record.status === "cancelled") {
          record.status = "pending";
          record.detached = false;
          added.push(key);
          this.emit({ type: "subtask-added", key, version: manifest.version });
        }
        continue;
      }
      if (record.status === "pending") {
        record.status = "cancelled";
        cancelled.push(key);
        this.emit({ type: "subtask-cancelled", key, version: manifest.version });
      } else if (record.status === "running") {
        record.detached = true;
        detached.push(key);
      }
    }

    for (const key of manifest.items) {
      if (!this.subtasks.has(key)) {
        this.subtasks.set(key, {
          status: "pending",
          addedIn: manifest.version,
          startedIn: null,
          detached: false,
        });
        added.push(key);
        this.emit({ type: "subtask-added", key, version: manifest.version });
      }
    }

    this.manifest = manifest;
    this.aggregatedForCurrent = false;

    const summary: ManifestApplySummary = {
      version: manifest.version,
      added,
      cancelled,
      detached,
    };
    this.emit({ type: "manifest-applied", summary });
    this.maybeAggregate();
    return summary;
  }

  startSubtask(key: string): void {
    const record = this.recordOf(key);
    if (record.status !== "pending") {
      throw new InvalidTransitionError(key, record.status, "running");
    }
    if (this.manifest === null) {
      throw new InvalidTransitionError(key, "pending", "running");
    }
    record.status = "running";
    record.startedIn = this.manifest.version;
    this.emit({ type: "subtask-started", key, version: record.startedIn });
  }

  completeSubtask(key: string, value: T, now: number = Date.now()): void {
    const record = this.recordOf(key);
    if (record.status !== "running") {
      throw new InvalidTransitionError(key, record.status, "succeeded");
    }
    record.status = "succeeded";
    const version = record.startedIn ?? record.addedIn;
    this.results.set(key, { key, version, value, completedAt: now });
    this.emit({ type: "subtask-succeeded", key, version });
    this.maybeAggregate();
  }

  failSubtask(key: string, error: unknown, now: number = Date.now()): void {
    const record = this.recordOf(key);
    if (record.status !== "running") {
      throw new InvalidTransitionError(key, record.status, "failed");
    }
    record.status = "failed";
    const version = record.startedIn ?? record.addedIn;
    this.failures.set(key, { key, version, error, failedAt: now });
    this.emit({ type: "subtask-failed", key, version });
    this.maybeAggregate();
  }

  isCurrentSetTerminal(): boolean {
    if (this.manifest === null) return false;
    return this.manifest.items.every((key) =>
      TERMINAL.has(this.subtasks.get(key)!.status),
    );
  }

  private maybeAggregate(): void {
    if (this.manifest === null || this.aggregatedForCurrent) return;
    if (!this.isCurrentSetTerminal()) return;
    this.aggregatedForCurrent = true;

    const results = new Map<string, SubtaskResult<T>>();
    const failures = new Map<string, SubtaskFailure>();
    for (const key of this.manifest.items) {
      const result = this.results.get(key);
      if (result !== undefined) results.set(key, result);
      const failure = this.failures.get(key);
      if (failure !== undefined) failures.set(key, failure);
    }

    const snapshot: AggregateSnapshot<T> = {
      version: this.manifest.version,
      results,
      failures,
    };
    this.emit({ type: "aggregate", snapshot });
  }

  private recordOf(key: string): SubtaskRecord {
    const record = this.subtasks.get(key);
    if (record === undefined) throw new UnknownSubtaskError(key);
    return record;
  }
}
