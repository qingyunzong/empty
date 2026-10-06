package boolexec

// Coverage is a frozen, immutable snapshot of the executor's per-node start
// counts for one AST version. Snapshots taken before a Replace are unaffected
// by later evaluation or replacement.
type Coverage struct {
	Version int
	Counts  map[string]uint64 // node ID -> number of started evaluations
	Hashes  map[string]uint64 // node ID -> structural hash at snapshot time
}

// Snapshot freezes the current counts into a Coverage table.
func (e *Executor) Snapshot() Coverage {
	e.mu.RLock()
	defer e.mu.RUnlock()
	cov := Coverage{
		Version: e.ses.version,
		Counts:  make(map[string]uint64, len(e.ses.counts)),
		Hashes:  make(map[string]uint64, len(e.ses.hashes)),
	}
	for id, c := range e.ses.counts {
		cov.Counts[id] = c.Load()
	}
	for id, h := range e.ses.hashes {
		cov.Hashes[id] = h
	}
	return cov
}

// Count returns the started-evaluation count for a node ID.
func (c Coverage) Count(id string) uint64 { return c.Counts[id] }

// Covered reports whether the node began evaluation at least once.
func (c Coverage) Covered(id string) bool { return c.Counts[id] > 0 }

// Total returns the sum of all node start counts.
func (c Coverage) Total() uint64 {
	var t uint64
	for _, v := range c.Counts {
		t += v
	}
	return t
}

// Migrated partitions the current executor counts against the frozen coverage
// of a previous version: carried holds counts preserved for stable-ID nodes
// whose structure is unchanged, and reset lists node IDs that were zeroed
// because their structure changed (or they are new). Removed IDs appear in
// neither. It is a pure read; Replace performs the actual migration.
func (e *Executor) Migrated(prev Coverage) (carried map[string]uint64, reset []string) {
	cur := e.Snapshot()
	carried = make(map[string]uint64)
	for id, h := range cur.Hashes {
		if ph, ok := prev.Hashes[id]; ok && ph == h {
			carried[id] = cur.Counts[id]
		} else {
			reset = append(reset, id)
		}
	}
	return carried, reset
}
