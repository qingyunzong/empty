import { DeltaSyncError } from "./errors.js";
import {
  applyDeltaChanges,
  compareServerVersions,
} from "./reconcile.js";
import type {
  CommitStats,
  CommitOptions,
  DeltaChange,
  DeltaCursor,
  DeltaStore,
  EntityRecord,
  MemoryDeltaStoreOptions,
  ODataEntity,
  VersionComparator,
} from "./types.js";

interface ResourceState<T extends ODataEntity> {
  readonly records: Map<string, EntityRecord<T>>;
  readonly cursor?: DeltaCursor;
}

function cloneEntity<T extends ODataEntity>(entity: T): T {
  return { ...entity };
}

function cloneRecord<T extends ODataEntity>(
  record: EntityRecord<T>,
): EntityRecord<T> {
  return {
    ...record,
    ...(record.entity === undefined
      ? {}
      : { entity: cloneEntity(record.entity) }),
  };
}

/**
 * In-memory reference store.
 *
 * Each commit is one synchronous state swap: records and cursor become visible
 * together, and a failure while applying the batch leaves the previous state
 * untouched.
 */
export class MemoryDeltaStore<T extends ODataEntity = ODataEntity>
  implements DeltaStore<T>
{
  private readonly states = new Map<string, ResourceState<T>>();
  private readonly compare: VersionComparator;

  constructor(options: MemoryDeltaStoreOptions = {}) {
    this.compare = options.compareVersions ?? compareServerVersions;
  }

  getCursor(resource: string): DeltaCursor | undefined {
    const cursor = this.states.get(resource)?.cursor;
    return cursor === undefined ? undefined : { deltaLink: cursor.deltaLink };
  }

  commit(
    resource: string,
    changes: readonly DeltaChange<T>[],
    cursor: DeltaCursor,
    options: CommitOptions = {},
  ): CommitStats {
    if (
      cursor === undefined ||
      cursor === null ||
      typeof cursor.deltaLink !== "string" ||
      cursor.deltaLink.trim().length === 0
    ) {
      throw new DeltaSyncError(
        "A commit must include a non-empty deltaLink",
        "INVALID_OPTIONS",
        { resumable: false },
      );
    }

    const previous = this.states.get(resource);
    if (options.expectedBaseDeltaLink !== undefined) {
      const currentBase = previous?.cursor?.deltaLink;
      const expectedBase = options.expectedBaseDeltaLink;
      const matches =
        expectedBase === null
          ? currentBase === undefined
          : currentBase === expectedBase;
      if (!matches) {
        throw new DeltaSyncError(
          `Cursor for "${resource}" changed while the delta round was in flight`,
          "CURSOR_CONFLICT",
          { resumable: false },
        );
      }
    }

    const { records, stats } = applyDeltaChanges(
      previous?.records ?? new Map<string, EntityRecord<T>>(),
      changes,
      options.compareVersions ?? this.compare,
    );

    // A single Map.set makes the record batch and its cursor visible together.
    this.states.set(resource, {
      records,
      cursor: { deltaLink: cursor.deltaLink.trim() },
    });
    return stats;
  }

  getRecord(resource: string, id: string): EntityRecord<T> | undefined {
    const record = this.states.get(resource)?.records.get(id);
    return record === undefined ? undefined : cloneRecord(record);
  }

  /**
   * Returns active entities and tombstones. Tombstones are retained so older,
   * late changes can be rejected by version.
   */
  listRecords(resource: string): EntityRecord<T>[] {
    const records = this.states.get(resource)?.records;
    if (records === undefined) {
      return [];
    }
    return [...records.values()]
      .sort((left, right) =>
        left.id < right.id ? -1 : left.id > right.id ? 1 : 0,
      )
      .map(cloneRecord);
  }

  /** Returns only live entities, sorted by id. */
  listEntities(resource: string): T[] {
    return this.listRecords(resource)
      .filter(
        (record): record is EntityRecord<T> & { entity: T; deleted: false } =>
          !record.deleted && record.entity !== undefined,
      )
      .map((record) => cloneEntity(record.entity));
  }

  listResources(): string[] {
    return [...this.states.keys()].sort((left, right) =>
      left < right ? -1 : left > right ? 1 : 0,
    );
  }

  clear(resource?: string): void {
    if (resource === undefined) {
      this.states.clear();
    } else {
      this.states.delete(resource);
    }
  }
}

export { MemoryDeltaStore as InMemoryDeltaStore };

export function createMemoryDeltaStore<T extends ODataEntity = ODataEntity>(
  options: MemoryDeltaStoreOptions = {},
): MemoryDeltaStore<T> {
  return new MemoryDeltaStore<T>(options);
}
