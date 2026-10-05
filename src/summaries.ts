import { sha256, type Hash } from "./hash.js";

/**
 * A module's source is split into a public interface portion and an
 * implementation portion. The compile cache hashes them independently so
 * that an implementation-only edit never invalidates dependents.
 */
export interface ModuleSource {
  readonly name: string;
  /** Public API surface (exported signatures, types...). */
  readonly iface: string;
  /** Implementation bodies, private helpers, comments... */
  readonly impl: string;
  /** Names of modules this module imports. */
  readonly imports: readonly string[];
}

export interface ModuleSummary {
  readonly name: string;
  readonly ifaceHash: Hash;
  readonly implHash: Hash;
  readonly imports: readonly string[];
}

const NAME_RE = /^[A-Za-z0-9_.-]+$/;

export function summarize(source: ModuleSource): ModuleSummary {
  if (!NAME_RE.test(source.name)) {
    throw new Error(`invalid module name: ${JSON.stringify(source.name)}`);
  }
  return {
    name: source.name,
    ifaceHash: sha256("iface", source.iface),
    implHash: sha256("impl", source.impl),
    imports: source.imports,
  };
}
