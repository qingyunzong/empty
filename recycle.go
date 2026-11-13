package dataeng

// RecycleList returns a copy of the safe-to-recycle list in insertion order.
// The garbage collector deletes the physical files described here and then
// calls AcknowledgeRecycled to prune the entries.
func (m *Manager) RecycleList() []RecycleItem {
	m.mu.RLock()
	defer m.mu.RUnlock()

	out := make([]RecycleItem, len(m.recycle))
	copy(out, m.recycle)
	return out
}

// AcknowledgeRecycled removes the given paths from the recycle list after they
// have been physically deleted and returns the number of entries removed.
// Unknown paths are ignored so retries stay idempotent.
func (m *Manager) AcknowledgeRecycled(paths ...string) int {
	if len(paths) == 0 {
		return 0
	}

	m.mu.Lock()
	defer m.mu.Unlock()

	pruned := make(map[string]struct{}, len(paths))
	for _, p := range paths {
		pruned[p] = struct{}{}
	}

	kept := m.recycle[:0]
	removed := 0
	for _, item := range m.recycle {
		if _, drop := pruned[item.Path]; drop {
			removed++
			continue
		}
		kept = append(kept, item)
	}
	m.recycle = kept
	return removed
}
