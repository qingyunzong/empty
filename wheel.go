package formal

import (
	"math"
	"time"
)

// wheelLevel is one sparse timing-wheel level. Buckets are keyed by their
// absolute window start rather than a mutable ring generation, which keeps
// restart and large clock jumps straightforward. The non-empty bucket heap is
// ordered by that same start, so advancing never scans empty slots.
type wheelLevel struct {
	index      int
	resolution int64 // nanoseconds represented by one slot
	span       int64 // nanoseconds covered by one complete revolution
	slots      int
	buckets    map[int64]*bucket
}

type bucket struct {
	level     int
	start     int64 // inclusive bucket start in Unix nanoseconds
	entries   []*entry
	heapIndex int
}

type entry struct {
	id       string
	due      time.Time
	dueNs    int64
	payload  any
	sequence uint64
	level    int
	bucket   *bucket
	position int
	state    entryState
}

type entryState uint8

const (
	statePending entryState = iota
	stateFired
	stateCancelled
)

func newLevel(index int, resolution int64, slots int) *wheelLevel {
	return &wheelLevel{
		index:      index,
		resolution: resolution,
		span:       saturatingMul(resolution, int64(slots)),
		slots:      slots,
		buckets:    make(map[int64]*bucket),
	}
}

func (b *bucket) add(e *entry) {
	e.bucket = b
	e.level = b.level
	e.position = len(b.entries)
	b.entries = append(b.entries, e)
}

func (b *bucket) remove(e *entry) {
	last := len(b.entries) - 1
	if e.position != last {
		moved := b.entries[last]
		b.entries[e.position] = moved
		moved.position = e.position
	}
	b.entries[last] = nil
	b.entries = b.entries[:last]
	e.bucket = nil
	e.position = -1
}

type bucketHeap []*bucket

func (h bucketHeap) Len() int { return len(h) }

func (h bucketHeap) Less(i, j int) bool {
	if h[i].start != h[j].start {
		return h[i].start < h[j].start
	}
	return h[i].level < h[j].level
}

func (h bucketHeap) Swap(i, j int) {
	h[i], h[j] = h[j], h[i]
	h[i].heapIndex = i
	h[j].heapIndex = j
}

func (h *bucketHeap) Push(x any) {
	b := x.(*bucket)
	b.heapIndex = len(*h)
	*h = append(*h, b)
}

func (h *bucketHeap) Pop() any {
	old := *h
	last := len(old) - 1
	b := old[last]
	old[last] = nil
	*h = old[:last]
	b.heapIndex = -1
	return b
}

func floorDiv(a, b int64) int64 {
	q := a / b
	if a%b != 0 && (a < 0) != (b < 0) {
		q--
	}
	return q
}

func floorTo(ns, resolution int64) int64 {
	return floorDiv(ns, resolution) * resolution
}

func saturatingMul(a, b int64) int64 {
	if a == 0 || b == 0 {
		return 0
	}
	if a > math.MaxInt64/b {
		return math.MaxInt64
	}
	return a * b
}
