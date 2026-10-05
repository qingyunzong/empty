# buildcache

Content-deduplicating build cache (Go standard library only).

- **Per-inode budget accounting**: multiple paths (hard links) to the same
  content are charged once. `Put` dedups by SHA-256; `Link` adds aliases.
- **Lease-protected eviction**: `Evict` removes only unleased paths,
  coldest inode first, and returns the eviction order. An inode's budget is
  released only when its last link disappears.
- **Crash-safe recovery**: writes are atomic via `*.tmp-*` siblings;
  `Open` rescans the directory, ignores incomplete temp files, and folds
  paths by inode so recovered usage matches a fresh cache.
- **Randomized cross-check**: `TestRandomHistoryCrossCheck` replays random
  put/link/remove/lease/evict histories and validates in-memory accounting
  against full disk scans, including across a recovery boundary.

Run tests: `go test ./...`
