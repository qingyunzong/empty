# cache

A byte-budgeted page cache for Go with leases, atomic eviction, and
singleflight asynchronous loading.

## Semantics

- **Fixed budget** — `used + reserved <= budget` always holds, where `used`
  is bytes held by cached pages and `reserved` is bytes reserved by
  in-flight loads. Both share the same budget.
- **Hits** — `Get`/`Lease` hits only update the page's access sequence
  number.
- **Leases** — `Lease` pins a page; pinned pages are never evicted.
  `Release` is idempotent: double release, or release after invalidation,
  is a no-op.
- **Eviction** — inserts evict the oldest (smallest sequence) unpinned
  pages. Insert failure is atomic: if the page cannot fit even after
  evicting every unpinned page, `ErrBudgetExhausted` is returned and
  nothing is evicted.
- **Async loading** — `Load` executes the loader exactly once per key
  (singleflight); concurrent waiters share the result. A load is cancelled
  only after *all* its waiters cancel. `Invalidate` (or a superseding
  `Insert`) bumps the page version, making the in-flight load's result
  unpublishable — waiters still receive the value, but it never enters the
  cache.

## Test

```sh
go test ./...
```

Tests include unit tests for the synchronous semantics, a randomized
differential test against a simple full-scan reference model
(`model_test.go`), and asynchronous loading tests driven by manually
resolved "promise" loaders (`load_test.go`).
