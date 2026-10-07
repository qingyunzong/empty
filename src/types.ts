export type ConfigObject = Record<string, unknown>;

/** A single reversible migration step between two adjacent versions. */
export interface Migration {
  /** Unique, sortable identifier, e.g. "003-add-theme". Used as tie-breaker. */
  id: string;
  from: string;
  to: string;
  /** Forward patch: config at `from` -> config at `to`. */
  up(config: ConfigObject): ConfigObject;
  /** Reverse patch: config at `to` -> config at `from`. */
  down(config: ConfigObject): ConfigObject;
}

/** Minimal file abstraction so the migrator can run on any storage. */
export interface FileAdapter {
  read(path: string): string | null;
  write(path: string, data: string): void;
  delete(path: string): void;
  exists(path: string): boolean;
}
