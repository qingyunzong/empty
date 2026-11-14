import { assertBusinessKey, keyToken } from "./keys.ts";
import type { BusinessKey, MaybePromise, RowAction } from "./types.ts";

export type JournalStatus = "pending" | "success" | "failed";

export interface JournalRecord {
  action: string;
  key: BusinessKey;
  status: JournalStatus;
  attempts: number;
  updatedAt: number;
  detail?: Record<string, unknown>;
}

export interface ActionJournalJson {
  version: 1;
  records: JournalRecord[];
}

export interface ActionJournalStorage {
  load(): MaybePromise<JournalRecord[]>;
  save(records: readonly JournalRecord[]): MaybePromise<void>;
}

function entryToken(action: string, key: BusinessKey): string {
  return JSON.stringify([action, keyToken(key)]);
}

/**
 * Durable-enough action ledger for RPA retries. A successful `(action, key)`
 * pair is never clicked again unless the caller explicitly clears it.
 */
export class ActionJournal {
  #records = new Map<string, JournalRecord>();
  #storage: ActionJournalStorage | undefined;

  constructor(
    records: Iterable<JournalRecord> = [],
    storage?: ActionJournalStorage,
  ) {
    this.#storage = storage;
    for (const record of records) {
      assertBusinessKey(record.key);
      this.#records.set(entryToken(record.action, record.key), { ...record });
    }
  }

  get size(): number {
    return this.#records.size;
  }

  get(action: RowAction | string, key: BusinessKey): JournalRecord | undefined {
    assertBusinessKey(key);
    return this.#records.get(entryToken(action, key));
  }

  hasSucceeded(action: RowAction | string, key: BusinessKey): boolean {
    return this.get(action, key)?.status === "success";
  }

  isPending(action: RowAction | string, key: BusinessKey): boolean {
    return this.get(action, key)?.status === "pending";
  }

  /**
   * Mark an attempt before invoking the adapter. If the process dies after a
   * click, the next run still takes a fresh snapshot before deciding whether a
   * click is required.
   */
  begin(
    action: RowAction | string,
    key: BusinessKey,
    detail?: Record<string, unknown>,
  ): JournalRecord {
    assertBusinessKey(key);
    const token = entryToken(action, key);
    const previous = this.#records.get(token);
    const record: JournalRecord = {
      action,
      key,
      status: "pending",
      attempts: (previous?.attempts ?? 0) + 1,
      updatedAt: Date.now(),
      detail,
    };
    this.#records.set(token, record);
    this.#scheduleSave();
    return record;
  }

  succeed(
    action: RowAction | string,
    key: BusinessKey,
    detail?: Record<string, unknown>,
  ): JournalRecord {
    assertBusinessKey(key);
    const token = entryToken(action, key);
    const previous = this.#records.get(token);
    const record: JournalRecord = {
      action,
      key,
      status: "success",
      attempts: previous?.attempts ?? 1,
      updatedAt: Date.now(),
      detail: detail ?? previous?.detail,
    };
    this.#records.set(token, record);
    this.#scheduleSave();
    return record;
  }

  fail(
    action: RowAction | string,
    key: BusinessKey,
    detail?: Record<string, unknown>,
  ): JournalRecord {
    assertBusinessKey(key);
    const token = entryToken(action, key);
    const previous = this.#records.get(token);
    const record: JournalRecord = {
      action,
      key,
      status: "failed",
      attempts: previous?.attempts ?? 1,
      updatedAt: Date.now(),
      detail: detail ?? previous?.detail,
    };
    this.#records.set(token, record);
    this.#scheduleSave();
    return record;
  }

  recordSuccess(
    action: RowAction | string,
    key: BusinessKey,
    detail?: Record<string, unknown>,
  ): JournalRecord {
    return this.succeed(action, key, detail);
  }

  records(): readonly JournalRecord[] {
    return [...this.#records.values()];
  }

  clear(action?: RowAction | string, key?: BusinessKey): void {
    if (action === undefined) {
      this.#records.clear();
      this.#scheduleSave();
      return;
    }
    if (key === undefined) {
      for (const [token, record] of this.#records) {
        if (record.action === action) {
          this.#records.delete(token);
        }
      }
      this.#scheduleSave();
      return;
    }
    assertBusinessKey(key);
    this.#records.delete(entryToken(action, key));
    this.#scheduleSave();
  }

  fork(): ActionJournal {
    return new ActionJournal(this.records());
  }

  toJSON(): ActionJournalJson {
    return { version: 1, records: this.records().map((record) => ({ ...record })) };
  }

  async flush(): Promise<void> {
    if (this.#storage !== undefined) {
      await this.#storage.save(this.records());
    }
  }

  static fromJSON(
    value: ActionJournalJson | string,
    storage?: ActionJournalStorage,
  ): ActionJournal {
    const parsed =
      typeof value === "string" ? (JSON.parse(value) as ActionJournalJson) : value;
    return new ActionJournal(parsed.records, storage);
  }

  static async load(storage: ActionJournalStorage): Promise<ActionJournal> {
    return new ActionJournal(await storage.load(), storage);
  }

  #scheduleSave(): void {
    if (this.#storage === undefined) {
      return;
    }
    // Persistence failures must not make an already-performed click look
    // unsuccessful. `flush()` is available for callers that need strict
    // durability before continuing.
    void Promise.resolve()
      .then(() => this.#storage!.save(this.records()))
      .catch(() => undefined);
  }
}
