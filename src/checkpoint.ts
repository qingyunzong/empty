import { createHash } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

import type { TimeWindow } from "./planner.ts";

/** Durable summary of one completed slice; used to skip re-publishing on resume. */
export interface SliceSummary {
  readonly key: string;
  readonly window: TimeWindow;
  readonly recordCount: number;
  /** SHA-256 over the ordered record keys of the slice. */
  readonly digest: string;
  readonly firstRecordKey: string | null;
  readonly lastRecordKey: string | null;
  readonly completedAt: string;
}

export function windowKey(window: TimeWindow): string {
  return `${window.startMs}:${window.endMs}`;
}

export function digestRecordKeys(keys: readonly string[]): string {
  const hash = createHash("sha256");
  for (const key of keys) {
    hash.update(key);
    hash.update("\n");
  }
  return hash.digest("hex");
}

export interface CheckpointStore {
  get(key: string): Promise<SliceSummary | undefined>;
  put(summary: SliceSummary): Promise<void>;
  all(): Promise<readonly SliceSummary[]>;
}

export class MemoryCheckpointStore implements CheckpointStore {
  readonly #summaries = new Map<string, SliceSummary>();

  async get(key: string): Promise<SliceSummary | undefined> {
    return this.#summaries.get(key);
  }

  async put(summary: SliceSummary): Promise<void> {
    this.#summaries.set(summary.key, summary);
  }

  async all(): Promise<readonly SliceSummary[]> {
    return [...this.#summaries.values()];
  }
}

/** JSON-file checkpoint store; writes are atomic via temp file + rename. */
export class FileCheckpointStore implements CheckpointStore {
  readonly #path: string;
  #cache: Map<string, SliceSummary> | null = null;

  constructor(path: string) {
    this.#path = path;
  }

  async get(key: string): Promise<SliceSummary | undefined> {
    return (await this.#load()).get(key);
  }

  async put(summary: SliceSummary): Promise<void> {
    const cache = await this.#load();
    cache.set(summary.key, summary);
    await this.#flush(cache);
  }

  async all(): Promise<readonly SliceSummary[]> {
    return [...(await this.#load()).values()];
  }

  async #load(): Promise<Map<string, SliceSummary>> {
    if (this.#cache !== null) {
      return this.#cache;
    }
    let summaries: SliceSummary[] = [];
    try {
      const raw = await readFile(this.#path, "utf8");
      const parsed: unknown = JSON.parse(raw);
      if (Array.isArray(parsed)) {
        summaries = parsed as SliceSummary[];
      }
    } catch (error) {
      if ((error as { code?: string }).code !== "ENOENT") {
        throw error;
      }
    }
    this.#cache = new Map(summaries.map((summary) => [summary.key, summary]));
    return this.#cache;
  }

  async #flush(cache: Map<string, SliceSummary>): Promise<void> {
    await mkdir(dirname(this.#path), { recursive: true });
    const tmpPath = `${this.#path}.tmp`;
    await writeFile(tmpPath, JSON.stringify([...cache.values()], null, 2));
    await rename(tmpPath, this.#path);
  }
}
