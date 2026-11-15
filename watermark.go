package dataeng

import "sync"

// Watermark tracks a contiguous prefix of completed shards. Shards may be
// marked out of order, but Value never advances across a missing sequence.
//
// Value is the first sequence that has not been marked, starting at the base
// supplied to NewWatermark. For example, marking 10 and 12 in a watermark based
// at 10 leaves Value at 11 until 11 is marked.
type Watermark struct {
	mu   sync.Mutex
	next int64
	done map[int64]struct{}
}

// NewWatermark returns a watermark whose base is start.
func NewWatermark(start int64) *Watermark {
	return &Watermark{
		next: start,
		done: make(map[int64]struct{}),
	}
}

// Mark records a shard as complete.
func (w *Watermark) Mark(sequence int64) {
	w.mu.Lock()
	defer w.mu.Unlock()
	if sequence < w.next {
		return
	}
	w.done[sequence] = struct{}{}
	for {
		if _, ok := w.done[w.next]; !ok {
			return
		}
		delete(w.done, w.next)
		w.next++
	}
}

// Value returns the first sequence that has not been completed contiguously.
func (w *Watermark) Value() int64 {
	w.mu.Lock()
	defer w.mu.Unlock()
	return w.next
}

// Marked reports whether sequence has been marked and not yet consumed by the
// contiguous prefix.
func (w *Watermark) Marked(sequence int64) bool {
	w.mu.Lock()
	defer w.mu.Unlock()
	_, ok := w.done[sequence]
	return ok
}
