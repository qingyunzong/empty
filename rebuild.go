package indexrebuild

// RebuildHooks lets tests observe and interleave with rebuild phases.
type RebuildHooks struct {
	// AfterBulkBuild runs after the frozen snapshot has been bulk-built but
	// before the incremental replay and the atomic switch. The rebuild holds
	// no locks while it runs, so the hook may commit mutations.
	AfterBulkBuild func()
}

// Rebuild builds a fresh index online and atomically switches queries to it:
//
//  1. Freeze: snapshot the main table and the source version atomically.
//  2. Bulk-build the new index from the frozen snapshot, lock-free.
//  3. Replay the incremental commit log to catch up with commits (puts and
//     deletes) that landed during the build.
//  4. Barrier: take the write lock, replay any remaining deltas, and swap
//     the active index. Because commits take the same write lock, no commit
//     can interleave between the final replay and the switch, so nothing —
//     including deletes — is lost.
//
// Until step 4 completes, Get keeps serving the old index.
func (e *Engine) Rebuild(hooks *RebuildHooks) *Index {
	// 1. Freeze the source version and snapshot atomically.
	e.mu.RLock()
	base := e.version
	snapshot := make(map[string]string, len(e.data))
	for k, v := range e.data {
		snapshot[k] = v
	}
	e.mu.RUnlock()

	// 2. Bulk build from the frozen snapshot.
	next := &Index{data: snapshot, version: base}

	if hooks != nil && hooks.AfterBulkBuild != nil {
		hooks.AfterBulkBuild()
	}

	// 3. Catch-up loop: drain the incremental log without blocking commits,
	//    so the critical section in step 4 stays short.
	for {
		e.mu.RLock()
		for _, d := range e.deltas {
			next.apply(d)
		}
		caughtUp := next.version == e.version
		e.mu.RUnlock()
		if caughtUp {
			break
		}
	}

	// 4. Barrier: final replay and atomic switch under the write lock.
	e.mu.Lock()
	for _, d := range e.deltas {
		next.apply(d)
	}
	e.active = next
	e.mu.Unlock()

	return next
}
