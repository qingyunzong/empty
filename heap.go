package timer

// entry is one pending occurrence of a timer in the scheduling heap. A timer
// may have several entries: rescheduling pushes a new entry with a bumped
// generation and leaves the old one behind as garbage. Entries whose
// generation no longer matches the timer are stale and skipped on pop.
type entry struct {
	deadline   uint64
	id         uint64
	generation uint64
}

// entryHeap is a min-heap ordered by (deadline, id): earlier deadlines first,
// ties broken by ascending timer ID so same-tick timers fire in ID order.
type entryHeap []entry

func (h entryHeap) Len() int { return len(h) }

func (h entryHeap) Less(i, j int) bool {
	if h[i].deadline != h[j].deadline {
		return h[i].deadline < h[j].deadline
	}
	return h[i].id < h[j].id
}

func (h entryHeap) Swap(i, j int) { h[i], h[j] = h[j], h[i] }

func (h *entryHeap) Push(x any) { *h = append(*h, x.(entry)) }

func (h *entryHeap) Pop() any {
	old := *h
	n := len(old)
	e := old[n-1]
	old[n-1] = entry{}
	*h = old[:n-1]
	return e
}
