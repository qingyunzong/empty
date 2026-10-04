import { sha256 } from "./hash.js";

/** A parsed module: implementation summary and public interface summary are kept separate. */
export interface ModuleRecord {
  name: string;
  source: string;
  /** Sorted, de-duplicated names of imported modules (may include missing ones). */
  deps: string[];
  /** Implementation summary: hash of the whole source text. */
  implHash: string;
  /** Public interface summary: hash of normalized exported declarations only. */
  ifaceHash: string;
}

export function parseImports(source: string): string[] {
  const deps = new Set<string>();
  for (const rawLine of source.split("\n")) {
    const line = rawLine.trim();
    const match = /^import\s+.+\s+from\s+["']([^"']+)["']\s*;?$/.exec(line);
    if (match) deps.add(match[1]);
  }
  return [...deps].sort();
}

export function parseInterface(source: string): string {
  const lines: string[] = [];
  for (const rawLine of source.split("\n")) {
    const line = rawLine.trim();
    if (line.startsWith("export ")) lines.push(line.replace(/\s+/g, " "));
  }
  return lines.join("\n");
}

export function makeRecord(name: string, source: string): ModuleRecord {
  return {
    name,
    source,
    deps: parseImports(source),
    implHash: sha256("impl\n" + source),
    ifaceHash: sha256("iface\n" + parseInterface(source)),
  };
}
