import type { ConfigData, FileAdapter, Journal, Migration } from './types.js';
import { VersionGraph } from './graph.js';

export class MigrationError extends Error {
  readonly phase: string;
  readonly journal: Journal | null;

  constructor(message: string, phase: string, cause: unknown, journal: Journal | null) {
    super(message, { cause });
    this.name = 'MigrationError';
    this.phase = phase;
    this.journal = journal;
  }
}

export class Migrator {
  private readonly graph: VersionGraph;
  private readonly adapter: FileAdapter;
  private readonly configPath: string;
  private readonly journalPath: string;

  constructor(graph: VersionGraph, adapter: FileAdapter, configPath: string = 'config.json', journalPath: string = 'migrate.journal.json') {
    this.graph = graph;
    this.adapter = adapter;
    this.configPath = configPath;
    this.journalPath = journalPath;
  }

  readConfig(): ConfigData | null {
    const raw = this.adapter.read(this.configPath);
    if (raw === null) return null;
    return JSON.parse(raw);
  }

  hasPending(): boolean {
    return this.adapter.read(this.journalPath) !== null;
  }

  migrate(target: string): ConfigData {
    if (this.hasPending()) {
      throw new MigrationError('unfinished migration journal exists; call recover() first', 'journal', null, this.loadJournal());
    }
    const config = this.readConfig();
    if (config === null) {
      throw new MigrationError('config not found at ' + this.configPath, 'read', null, null);
    }
    const path = this.graph.findPath(config.version, target);
    if (path === null) {
      throw new MigrationError('no migration path from ' + config.version + ' to ' + target, 'plan', null, null);
    }
    if (path.length === 0) return config;

    const journal: Journal = {
      status: 'migrating',
      from: config.version,
      target,
      path: path.map((m) => m.id),
      applied: 0,
      rollbackIndex: -1,
    };
    this.saveJournal(journal);

    let current = config;
    for (let i = 0; i < path.length; i++) {
      const step = path[i];
      let next: ConfigData;
      try {
        next = step.up(current);
      } catch (err) {
        journal.status = 'rolling-back';
        journal.rollbackIndex = journal.applied - 1;
        this.saveJournal(journal);
        this.rollback(journal, path);
        this.clearJournal();
        throw new MigrationError('migration step ' + step.id + ' failed; rolled back to ' + journal.from, 'apply', err, null);
      }
      current = { ...next, version: step.to };
      this.writeConfig(current);
      journal.applied = i + 1;
      this.saveJournal(journal);
    }
    this.clearJournal();
    return current;
  }

  // Resume after a crash or a failed rollback. Safe to call repeatedly:
  // with no journal it is a no-op. Progress is derived from the persisted
  // config version, so recovery is correct no matter which write was lost.
  recover(): ConfigData | null {
    const journal = this.loadJournal();
    if (journal === null) return this.readConfig();
    const path = this.resolvePath(journal);
    const config = this.readConfig();
    if (config === null) {
      throw new MigrationError('config missing during recovery', 'recover', null, journal);
    }
    let rollbackIndex = -1;
    if (config.version !== journal.from) {
      rollbackIndex = this.indexOfVersion(path, config.version);
      if (rollbackIndex === -1) {
        throw new MigrationError('config version ' + config.version + ' is not on the journaled migration path', 'recover', null, journal);
      }
    }
    journal.status = 'rolling-back';
    journal.rollbackIndex = rollbackIndex;
    this.saveJournal(journal);
    const restored = this.rollback(journal, path);
    this.clearJournal();
    return restored;
  }

  private rollback(journal: Journal, path: Migration[]): ConfigData {
    let current = this.readConfig();
    if (current === null) {
      throw new MigrationError('config missing during rollback', 'rollback', null, journal);
    }
    while (journal.rollbackIndex >= 0) {
      const step = path[journal.rollbackIndex];
      let next: ConfigData;
      try {
        next = step.down(current);
      } catch (err) {
        // Keep the journal pointing at the failed step so a later recover()
        // resumes the rollback from exactly this position.
        this.saveJournal(journal);
        throw new MigrationError('rollback failed at step ' + step.id + '; resume position kept in journal', 'rollback', err, journal);
      }
      current = { ...next, version: step.from };
      this.writeConfig(current);
      journal.rollbackIndex -= 1;
      this.saveJournal(journal);
    }
    return current;
  }

  private resolvePath(journal: Journal): Migration[] {
    const path: Migration[] = [];
    for (const id of journal.path) {
      const m = this.graph.getById(id);
      if (m === null) {
        throw new MigrationError('journal references unknown migration ' + id, 'recover', null, journal);
      }
      path.push(m);
    }
    return path;
  }

  private indexOfVersion(path: Migration[], version: string): number {
    for (let i = 0; i < path.length; i++) {
      if (path[i].to === version) return i;
    }
    return -1;
  }

  private loadJournal(): Journal | null {
    const raw = this.adapter.read(this.journalPath);
    if (raw === null) return null;
    return JSON.parse(raw);
  }

  private saveJournal(journal: Journal): void {
    this.adapter.write(this.journalPath, JSON.stringify(journal, null, 2));
  }

  private clearJournal(): void {
    this.adapter.delete(this.journalPath);
  }

  private writeConfig(config: ConfigData): void {
    this.adapter.write(this.configPath, JSON.stringify(config, null, 2));
  }
}
