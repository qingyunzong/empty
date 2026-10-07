import { CharId, Cursor, Op, Range, Selection, TextModel } from './model';

/**
 * Paged storage over a {@link TextModel}.
 *
 * The logical sequence of surviving characters is split into pages of at
 * most `pageSize` entries. Pages are pure storage buckets: rebalancing may
 * move a character from one page to another, but its {@link CharId} (and the
 * underlying node object) never changes, so id-anchored selections are
 * unaffected by pagination.
 */
export class PagedTextModel {
  readonly model = new TextModel();
  private pages: CharId[][] = [[]];

  constructor(readonly pageSize: number = 64) {
    if (pageSize < 1) throw new Error('pageSize must be >= 1');
  }

  apply(op: Op): void {
    this.model.apply(op);
    this.rebalance();
  }

  applyAll(ops: readonly Op[]): void {
    for (const op of ops) this.apply(op);
  }

  /** Re-pack surviving characters into pages; ids are moved, never changed. */
  private rebalance(): void {
    const live = this.model.liveIds();
    const next: CharId[][] = [];
    for (let i = 0; i < live.length; i += this.pageSize) {
      next.push(live.slice(i, i + this.pageSize));
    }
    this.pages = next.length > 0 ? next : [[]];
  }

  get pageCount(): number {
    return this.pages.length;
  }

  /** Ids stored on a page, in document order. */
  page(pageIndex: number): readonly CharId[] {
    const page = this.pages[pageIndex];
    if (!page) throw new RangeError(`no page ${pageIndex}`);
    return page;
  }

  /** Text of a single page. */
  pageText(pageIndex: number): string {
    return this.page(pageIndex)
      .map((id) => this.model.get(id)!.value)
      .join('');
  }

  /** Locate a character: which page it lives on and its offset there. */
  locate(id: CharId): { page: number; index: number } | null {
    for (let p = 0; p < this.pages.length; p += 1) {
      const index = this.pages[p]!.indexOf(id);
      if (index !== -1) return { page: p, index };
    }
    return null;
  }

  text(): string {
    return this.model.text();
  }

  resolveCursor(cursor: Cursor): number {
    return this.model.resolveCursor(cursor);
  }

  resolveSelection(selection: Selection): Range {
    return this.model.resolveSelection(selection);
  }
}
