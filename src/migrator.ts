import { findPath } from "./graph";
import type { ConfigObject, FileAdapter, Migration } from "./types";

export type MigrateStatus =
  | "migrated" // reached the target version
  | "already-current" // nothing to do (also: recover with no journal)
  | "rolled-back" // a failure was fully undone, config back at the origin
  | "rollback-paused"; // a reverse patch failed; journal keeps the resume point

export interface MigrateResult {
  status: MigrateStatus;
  /** Config version after the call. */
  version: string;
  /** Migration ids applied forward during this call. */
  applied: string[];
  /** Migration ids undone during this call. */
  reverted: string[];
  error?: string;
}

interface Journal {
  startedFrom: string;
  target: string;
  path: string[]; // migration ids, in application order
  phase: "migrating" | "rolling-back";
}

export interface MigratorOptions {
  adapter: FileAdapter;
  configPath: string;
  migrations: Migration[];
  /** Config field holding the version string. Defaults to "version". */
  versionKey?: string;
}

/**
 * Runs config migrations selected from a version graph. Every step is
 * reversible; a failing forward step triggers a reverse-order rollback of
 * the steps already applied. If a reverse patch itself fails, the journal
 * file keeps the exact resume position so a later recover() call can
 * continue the rollback (also after a power cut).
 */
export class Migrator {
  private readonly adapter: FileAdapter;
  private readonly configPath: string;
  private readonly journalPath: string;
  private readonly migrations: Migration[];
  private readonly versionKey: string;

  constructor(options: MigratorOptions) {
    this.adapter = options.adapter;
    this.configPath = options.configPath;
    this.journalPath = options.configPath + ".journal";
    this.migrations = options.migrations;
    this.versionKey = options.versionKey ?? "version";
  }

  currentVersion(): string {
    return String(this.readConfig()[this.versionKey]);
  }

  /**
   * Migrate to `target` (default: the unique sink of the version graph).
   * Adapter errors (e.g. power cuts) propagate to the caller; migration
   * patch errors are contained and reported in the result.
   */
  migrate(target?: string): MigrateResult {
    if (this.adapter.exists(this.journalPath)) {
      throw new Error(
        `unfinished migration journal at ${this.journalPath}; call recover() first`,
      );
    }
    const config = this.readConfig();
    const origin = String(config[this.versionKey]);
    const goal = target ?? this.defaultTarget();
    const path = findPath(this.migrations, origin, goal);
    if (path.length === 0) {
      return { status: "already-current", version: origin, applied: [], reverted: [] };
    }

    const journal: Journal = {
      startedFrom: origin,
      target: goal,
      path: path.map((step) => step.id),
      phase: "migrating",
    };
    this.writeJournal(journal);

    let current = config;
    const applied: string[] = [];
    for (const step of path) {
      let next: ConfigObject;
      try {
        next = step.up(current);
      } catch (error) {
        journal.phase = "rolling-back";
        this.writeJournal(journal);
        return this.rollback(current, path, applied.length, origin, applied, error);
      }
      next[this.versionKey] = step.to;
      this.writeConfig(next);
      current = next;
      applied.push(step.id);
    }

    this.adapter.delete(this.journalPath);
    return { status: "migrated", version: goal, applied, reverted: [] };
  }

  /**
   * Resume an interrupted migration by finishing its rollback. Safe to call
   * repeatedly: with no journal it is a no-op, and after a paused rollback
   * it continues exactly where the previous attempt stopped.
   */
  recover(): MigrateResult {
    if (!this.adapter.exists(this.journalPath)) {
      return {
        status: "already-current",
        version: this.currentVersion(),
        applied: [],
        reverted: [],
      };
    }
    const journal = this.readJournal();
    const path = journal.path.map((id) => {
      const step = this.migrations.find((m) => m.id === id);
      if (!step) throw new Error(`journal references unknown migration "${id}"`);
      return step;
    });

    // Reconcile position from the on-disk config version: the write of the
    // config file is the commit point of each step, so the version field
    // tells us exactly how many steps are still in effect.
    const version = this.currentVersion();
    let appliedCount = 0;
    if (version !== journal.startedFrom) {
      const index = path.findIndex((step) => step.to === version);
      if (index === -1) {
        throw new Error(
          `config version "${version}" is not on the journaled migration path`,
        );
      }
      appliedCount = index + 1;
    }

    journal.phase = "rolling-back";
    this.writeJournal(journal);
    return this.rollback(
      this.readConfig(),
      path,
      appliedCount,
      journal.startedFrom,
      [],
      undefined,
    );
  }

  /** Undo `appliedCount` steps of `path` in reverse order. */
  private rollback(
    config: ConfigObject,
    path: Migration[],
    appliedCount: number,
    origin: string,
    applied: string[],
    cause: unknown,
  ): MigrateResult {
    let current = config;
    const reverted: string[] = [];
    for (let i = appliedCount - 1; i >= 0; i--) {
      const step = path[i]!;
      let previous: ConfigObject;
      try {
        previous = step.down(current);
      } catch (error) {
        // Journal stays on disk: version field + journal mark the resume point.
        return {
          status: "rollback-paused",
          version: String(current[this.versionKey]),
          applied,
          reverted,
          error: `reverse patch "${step.id}" failed: ${messageOf(error)}`,
        };
      }
      previous[this.versionKey] = i === 0 ? origin : path[i - 1]!.to;
      this.writeConfig(previous);
      current = previous;
      reverted.push(step.id);
    }
    this.adapter.delete(this.journalPath);
    return {
      status: "rolled-back",
      version: origin,
      applied,
      reverted,
      error: cause === undefined ? undefined : `migration failed: ${messageOf(cause)}`,
    };
  }

  private defaultTarget(): string {
    const sources = new Set(this.migrations.map((m) => m.from));
    const sinks = [...new Set(this.migrations.map((m) => m.to))].filter(
      (v) => !sources.has(v),
    );
    if (sinks.length !== 1) {
      throw new Error(
        `cannot infer target version (sinks: ${sinks.join(", ") || "none"}); pass it explicitly`,
      );
    }
    return sinks[0]!;
  }

  private readConfig(): ConfigObject {
    const raw = this.adapter.read(this.configPath);
    if (raw === null) throw new Error(`config not found at ${this.configPath}`);
    return JSON.parse(raw) as ConfigObject;
  }

  private writeConfig(config: ConfigObject): void {
    this.adapter.write(this.configPath, JSON.stringify(config, null, 2));
  }

  private readJournal(): Journal {
    const raw = this.adapter.read(this.journalPath);
    if (raw === null) throw new Error(`journal not found at ${this.journalPath}`);
    return JSON.parse(raw) as Journal;
  }

  private writeJournal(journal: Journal): void {
    this.adapter.write(this.journalPath, JSON.stringify(journal, null, 2));
  }
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
