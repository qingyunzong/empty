import { InMemoryAdapter } from "./adapter.js";
import { SyncEngine } from "./sync.js";
import type { Page, Snapshot } from "./types.js";

/**
 * Crash-free oracle: applies every page once, in order, to an in-memory
 * adapter. `prefixes[i]` is the exact expected state after pages[0..i-1],
 * with prefixes[0] the empty state.
 */
export function applySequentially(pages: Page[]): {
  final: Snapshot;
  prefixes: Snapshot[];
} {
  const engine = new SyncEngine(new InMemoryAdapter());
  const prefixes: Snapshot[] = [engine.snapshot()];
  for (const page of pages) {
    engine.applyPage(page);
    prefixes.push(engine.snapshot());
  }
  return { final: prefixes[prefixes.length - 1]!, prefixes };
}
