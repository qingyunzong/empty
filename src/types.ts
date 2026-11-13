export type SubtaskStatus =
  | "pending"
  | "running"
  | "succeeded"
  | "failed"
  | "cancelled";

export interface Manifest {
  readonly version: string;
  readonly items: readonly string[];
}

export interface SubtaskResult<T = unknown> {
  readonly key: string;
  readonly version: string;
  readonly value: T;
  readonly completedAt: number;
}

export interface SubtaskFailure {
  readonly key: string;
  readonly version: string;
  readonly error: unknown;
  readonly failedAt: number;
}

export interface AggregateSnapshot<T = unknown> {
  readonly version: string;
  readonly results: ReadonlyMap<string, SubtaskResult<T>>;
  readonly failures: ReadonlyMap<string, SubtaskFailure>;
}

export interface ManifestApplySummary {
  readonly version: string;
  readonly added: readonly string[];
  readonly cancelled: readonly string[];
  readonly detached: readonly string[];
}

export type MapStateEvent<T = unknown> =
  | { readonly type: "manifest-applied"; readonly summary: ManifestApplySummary }
  | { readonly type: "manifest-ignored"; readonly version: string }
  | { readonly type: "subtask-added"; readonly key: string; readonly version: string }
  | { readonly type: "subtask-started"; readonly key: string; readonly version: string }
  | { readonly type: "subtask-succeeded"; readonly key: string; readonly version: string }
  | { readonly type: "subtask-failed"; readonly key: string; readonly version: string }
  | { readonly type: "subtask-cancelled"; readonly key: string; readonly version: string }
  | { readonly type: "aggregate"; readonly snapshot: AggregateSnapshot<T> };

export class ManifestConflictError extends Error {
  constructor(version: string) {
    super(
      `manifest version "${version}" was already applied with different items`,
    );
    this.name = "ManifestConflictError";
  }
}

export class InvalidManifestError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InvalidManifestError";
  }
}

export class UnknownSubtaskError extends Error {
  constructor(key: string) {
    super(`unknown subtask "${key}"`);
    this.name = "UnknownSubtaskError";
  }
}

export class InvalidTransitionError extends Error {
  constructor(key: string, from: SubtaskStatus, to: SubtaskStatus) {
    super(`subtask "${key}" cannot transition from "${from}" to "${to}"`);
    this.name = "InvalidTransitionError";
  }
}
