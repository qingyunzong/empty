import type {
  DualWriteGap,
  GapJournal,
} from "./types.js";
import { compareSourceVersions } from "./version.js";

/**
 * Small durable-port implementation for tests and single-process workers.
 * Production deployments can provide the same interface backed by a database.
 */
export class InMemoryGapJournal implements GapJournal {
  readonly #gaps = new Map<string, DualWriteGap>();

  append(gap: DualWriteGap): void {
    const existing = this.#gaps.get(gap.id);
    this.#gaps.set(gap.id, {
      ...gap,
      attempts: existing ? Math.max(existing.attempts, gap.attempts) : gap.attempts,
    });
  }

  list(generation?: string): readonly DualWriteGap[] {
    return [...this.#gaps.values()]
      .filter(
        (gap) =>
          gap.resolvedAt === undefined &&
          (generation === undefined || gap.generation === generation),
      )
      .sort((left, right) => {
        if (left.generation !== right.generation) {
          return left.generation < right.generation ? -1 : 1;
        }
        const versionOrder = compareSourceVersions(
          left.sourceVersion,
          right.sourceVersion,
        );
        if (versionOrder === 0) {
          return left.changeKey < right.changeKey
            ? -1
            : left.changeKey > right.changeKey
              ? 1
              : 0;
        }
        return versionOrder;
      });
  }

  resolve(ids: readonly string[]): void {
    const resolvedAt = new Date().toISOString();
    for (const id of ids) {
      const existing = this.#gaps.get(id);
      if (existing && existing.resolvedAt === undefined) {
        this.#gaps.set(id, { ...existing, resolvedAt });
      }
    }
  }

  all(): readonly DualWriteGap[] {
    return [...this.#gaps.values()];
  }
}
