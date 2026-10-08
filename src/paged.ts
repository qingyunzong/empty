import { Document } from "./document.js";
import { OpId, sameOpId } from "./ids.js";
import {
  Selection,
  ResolvedSelection,
  resolveSelection,
} from "./selection.js";

export interface Page {
  index: number;
  ids: OpId[];
  text: string;
}

export interface CaretPosition {
  offset: number;
  page: number;
  offsetInPage: number;
}

export interface PagedSelection extends ResolvedSelection {
  startPos: CaretPosition;
  endPos: CaretPosition;
}

export class PagedDocument {
  private pageSizes: number[] = [];

  constructor(
    readonly doc: Document,
    pageCapacity: number,
  ) {
    this.reflow(pageCapacity);
  }

  reflow(capacity: number): void {
    if (!Number.isInteger(capacity) || capacity < 1) {
      throw new RangeError("capacity must be a positive integer");
    }
    let remaining = this.doc.visibleEntries().length;
    const sizes: number[] = [];
    while (remaining > 0) {
      const size = Math.min(capacity, remaining);
      sizes.push(size);
      remaining -= size;
    }
    if (sizes.length === 0) sizes.push(0);
    this.pageSizes = sizes;
  }

  moveAcrossPageBoundary(pageIndex: number, count: number): void {
    if (pageIndex < 0 || pageIndex + 1 >= this.pageSizes.length) {
      throw new RangeError(`no page boundary after page ${pageIndex}`);
    }
    if (count < 0 || count > this.pageSizes[pageIndex]) {
      throw new RangeError(
        `cannot move ${count} chars from page ${pageIndex} of size ${this.pageSizes[pageIndex]}`,
      );
    }
    this.pageSizes[pageIndex] -= count;
    this.pageSizes[pageIndex + 1] += count;
  }

  pages(): Page[] {
    const visible = this.doc.visibleEntries();
    const pages: Page[] = [];
    let cursor = 0;
    for (let i = 0; i < this.pageSizes.length; i++) {
      const left = visible.length - cursor;
      const size =
        i === this.pageSizes.length - 1
          ? left
          : Math.min(this.pageSizes[i], left);
      const slice = visible.slice(cursor, cursor + size);
      pages.push({
        index: i,
        ids: slice.map((entry) => entry.id),
        text: slice.map((entry) => entry.char).join(""),
      });
      cursor += size;
    }
    return pages;
  }

  locate(id: OpId): CaretPosition | null {
    let base = 0;
    for (const page of this.pages()) {
      const at = page.ids.findIndex((pageId) => sameOpId(pageId, id));
      if (at !== -1) {
        return { offset: base + at, page: page.index, offsetInPage: at };
      }
      base += page.ids.length;
    }
    return null;
  }

  resolveCaret(offset: number): CaretPosition {
    const pages = this.pages();
    let base = 0;
    for (const page of pages) {
      if (offset < base + page.ids.length) {
        return { offset, page: page.index, offsetInPage: offset - base };
      }
      base += page.ids.length;
    }
    const last = pages[pages.length - 1];
    return { offset, page: last.index, offsetInPage: last.ids.length };
  }

  resolveSelection(selection: Selection): PagedSelection {
    const resolved = resolveSelection(this.doc, selection);
    return {
      ...resolved,
      startPos: this.resolveCaret(resolved.start),
      endPos: this.resolveCaret(resolved.end),
    };
  }
}
