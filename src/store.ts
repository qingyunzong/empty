import { evaluateFeature } from "./engine.ts";
import { VersionAlreadyPublishedError, VersionNotPublishedError } from "./errors.ts";
import type {
  FeatureDefinition,
  FeatureEvent,
  FeatureResult,
  PointQuery,
} from "./types.ts";

/**
 * Immutable, fully-materialized view of one feature version.
 *
 * The handle is built completely before it becomes visible to any reader.
 * Every lookup pins its handle at call entry, so an in-flight request keeps
 * evaluating against the version it started with even if a newer version is
 * published while it is awaiting.
 */
export interface VersionHandle {
  readonly definition: FeatureDefinition;
  /** Ascending per-entity event lists, frozen at publish time. */
  readonly eventsByEntity: ReadonlyMap<string, readonly FeatureEvent[]>;
}

/**
 * Mutable staging area for a version under backfill. Nothing written to a
 * staging area is observable through the store until `publish` commits it.
 */
export interface StagingVersion {
  readonly versionId: string;
  /**
   * Append events for one entity. May be called repeatedly and interleaved
   * with other work; staged data stays invisible to readers.
   */
  addEvents(entityId: string, events: readonly FeatureEvent[]): void;
}

function deepFreeze<T>(value: T): T {
  if (value === null || typeof value !== "object" || Object.isFrozen(value)) {
    return value;
  }
  Object.freeze(value);
  for (const key of Reflect.ownKeys(value)) {
    const child = (value as Record<PropertyKey, unknown>)[key as PropertyKey];
    if (child !== null && typeof child === "object") {
      deepFreeze(child);
    }
  }
  return value;
}

const EMPTY_EVENTS: readonly FeatureEvent[] = Object.freeze([]);

interface StagingState {
  definition: FeatureDefinition;
  draft: Map<string, FeatureEvent[]>;
  consumed: boolean;
}

/**
 * Embeddable feature store.
 *
 * Concurrency model:
 *  - `stageVersion` opens an invisible draft; backfill writes go to the draft.
 *  - `publish` builds the complete immutable snapshot first, then performs a
 *    single map insertion — the only publication step — so readers can never
 *    observe a partially published version.
 *  - `lookup` resolves and pins the handle before its first await and never
 *    re-reads shared state afterwards, hence a version switch only affects
 *    new requests.
 */
export class FeatureStore {
  readonly #published = new Map<string, VersionHandle>();
  readonly #staging = new Map<string, StagingState>();
  #activeVersionId: string | null = null;

  /** Currently active published version id, or null if none is published. */
  get activeVersionId(): string | null {
    return this.#activeVersionId;
  }

  listPublishedVersions(): string[] {
    return [...this.#published.keys()];
  }

  stageVersion(definition: FeatureDefinition): StagingVersion {
    if (this.#published.has(definition.versionId)) {
      throw new VersionAlreadyPublishedError(definition.versionId);
    }
    const state: StagingState = {
      definition,
      draft: new Map(),
      consumed: false,
    };
    this.#staging.set(definition.versionId, state);
    const store = this;

    return {
      versionId: definition.versionId,
      addEvents(entityId: string, events: readonly FeatureEvent[]): void {
        if (state.consumed) {
          throw new VersionAlreadyPublishedError(definition.versionId);
        }
        let bucket = state.draft.get(entityId);
        if (bucket === undefined) {
          bucket = [];
          state.draft.set(entityId, bucket);
        }
        for (const event of events) {
          bucket.push({ entityId, eventTime: event.eventTime, value: event.value });
        }
      },
    };
  }

  /**
   * Atomically publish a staged version.
   *
   * All per-entity event lists are sorted and frozen before the published map
   * is touched. The publication itself is one synchronous map insertion, which
   * is atomic with respect to every other synchronous JS turn; no lookup can
   * interleave midway through.
   */
  publish(staging: StagingVersion, makeActive = true): VersionHandle {
    const state = this.#staging.get(staging.versionId);
    if (state === undefined || state.consumed) {
      throw new VersionAlreadyPublishedError(staging.versionId);
    }
    if (this.#published.has(staging.versionId)) {
      throw new VersionAlreadyPublishedError(staging.versionId);
    }
    state.consumed = true;
    this.#staging.delete(staging.versionId);

    const eventsByEntity = new Map<string, readonly FeatureEvent[]>();
    for (const [entityId, events] of state.draft) {
      events.sort((left, right) => left.eventTime - right.eventTime);
      eventsByEntity.set(entityId, deepFreeze(events));
    }

    const handle: VersionHandle = deepFreeze({
      definition: deepFreeze({ ...state.definition }),
      eventsByEntity,
    });

    this.#published.set(staging.versionId, handle);
    if (makeActive) {
      this.#activeVersionId = staging.versionId;
    }
    return handle;
  }

  #resolveHandle(versionId: string | undefined): VersionHandle {
    const resolvedId = versionId ?? this.#activeVersionId;
    if (resolvedId === null) {
      throw new VersionNotPublishedError("<no active version>");
    }
    const handle = this.#published.get(resolvedId);
    if (handle === undefined) {
      // Staged-but-unpublished and completely unknown versions fail identically.
      throw new VersionNotPublishedError(resolvedId);
    }
    return handle;
  }

  /**
   * Online point lookup.
   *
   * The version handle and the entity event slice are captured synchronously
   * before any await, pinning the request to one immutable snapshot for its
   * whole lifetime. Publishing another version afterwards cannot change the
   * result of this call.
   */
  async lookup(query: PointQuery, versionId?: string): Promise<FeatureResult> {
    const handle = this.#resolveHandle(versionId);
    const events = handle.eventsByEntity.get(query.entityId) ?? EMPTY_EVENTS;
    return evaluateFeature(handle.definition, events, query);
  }
}
