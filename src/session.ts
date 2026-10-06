import { ResultMerger, type SearchHit, type SearchPage } from "./merger.js";

const CANCELLED: unique symbol = Symbol("cancelled");

/**
 * One issued query. Owns a private merger, so pages of a cancelled query can
 * never leak into the results of its successor.
 */
export class QueryHandle {
  readonly merger = new ResultMerger();
  private _cancelled = false;
  private signalCancel: () => void = () => {};
  private readonly cancelPromise: Promise<typeof CANCELLED>;

  constructor(readonly id: number) {
    this.cancelPromise = new Promise((resolve) => {
      this.signalCancel = () => resolve(CANCELLED);
    });
  }

  get cancelled(): boolean {
    return this._cancelled;
  }

  cancel(): void {
    if (this._cancelled) return;
    this._cancelled = true;
    this.signalCancel();
  }

  /** Ingest one page. Returns false when the query is already cancelled. */
  ingest(page: SearchPage): boolean {
    if (this._cancelled) return false;
    this.merger.applyPage(page);
    return true;
  }

  /**
   * Consume an async page source until it ends or the query is cancelled,
   * whichever comes first. Pages still in flight when the cancellation
   * happens are discarded.
   */
  async drain(source: AsyncIterable<SearchPage>): Promise<SearchHit[]> {
    const iterator = source[Symbol.asyncIterator]();
    try {
      for (;;) {
        const step = await Promise.race([iterator.next(), this.cancelPromise]);
        if (step === CANCELLED || this._cancelled) break;
        if (step.done) break;
        this.merger.applyPage(step.value);
      }
    } finally {
      await iterator.return?.();
    }
    return this.merger.results();
  }

  results(): SearchHit[] {
    return this.merger.results();
  }
}

/**
 * Issues queries and routes pages to them. Starting a new query cancels the
 * previous one; pages dispatched through a stale handle are rejected.
 */
export class SearchSession {
  private nextId = 0;
  private active: QueryHandle | null = null;

  beginQuery(): QueryHandle {
    this.active?.cancel();
    const handle = new QueryHandle(++this.nextId);
    this.active = handle;
    return handle;
  }

  get activeQuery(): QueryHandle | null {
    return this.active;
  }

  /** Route a page through its handle; stale or cancelled handles are rejected. */
  dispatch(handle: QueryHandle, page: SearchPage): boolean {
    if (handle !== this.active) return false;
    return handle.ingest(page);
  }
}
