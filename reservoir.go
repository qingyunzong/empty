package dataeng

import (
	"container/heap"
	"fmt"
	"math"
	"sort"
	"sync"
)

// Record is one weighted item in a reservoir. ID is the unique identity used
// for hashing, deduplication, and deterministic tie-breaking. Priority is
// derived from ID and Weight by AddRecord and is reported in results.
//
// Item and Candidate are aliases of Record.
type Record struct {
	ID       string  `json:"id"`
	Weight   float64 `json:"weight"`
	Priority float64 `json:"priority,omitempty"`
	Value    any     `json:"value,omitempty"`
}

// Item is an alias for Record.
type Item = Record

// Candidate is an alias for Record.
type Candidate = Record

// Entry is an alias for Record.
type Entry = Record

// Reservoir keeps the top K records by deterministic weighted priority.
//
// A Reservoir is safe for concurrent use. The zero value is an invalid,
// zero-capacity reservoir; use New or NewReservoir to create one.
type Reservoir struct {
	mu       sync.Mutex
	k        int
	invalidK error
	byID     map[string]Record
	heap     recordHeap
}

// PriorityReservoir is an alias for Reservoir.
type PriorityReservoir = Reservoir

// Sampler is an alias for Reservoir.
type Sampler = Reservoir

// New creates a reservoir that retains the best k records.
//
// If k is not positive, the returned reservoir is empty and Add reports
// ErrInvalidK. Use NewChecked when an immediate error is preferred.
func New(k int) *Reservoir {
	r := &Reservoir{k: k}
	if k <= 0 {
		r.invalidK = fmt.Errorf("%w: %d", ErrInvalidK, k)
		return r
	}
	r.byID = make(map[string]Record, k)
	return r
}

// NewReservoir is an alias for New.
func NewReservoir(k int) *Reservoir { return New(k) }

// NewSampler is an alias for New.
func NewSampler(k int) *Reservoir { return New(k) }

// NewPriorityReservoir is an alias for New.
func NewPriorityReservoir(k int) *Reservoir { return New(k) }

// NewState is an alias for New.
func NewState(k int) *Reservoir { return New(k) }

// NewChecked creates a reservoir and immediately validates k.
func NewChecked(k int) (*Reservoir, error) {
	if k <= 0 {
		return nil, fmt.Errorf("%w: %d", ErrInvalidK, k)
	}
	return New(k), nil
}

// MustNew creates a reservoir and panics if k is not positive.
func MustNew(k int) *Reservoir {
	r, err := NewChecked(k)
	if err != nil {
		panic(err)
	}
	return r
}

// K returns the reservoir capacity.
func (r *Reservoir) K() int {
	if r == nil {
		return 0
	}
	r.mu.Lock()
	defer r.mu.Unlock()
	return r.k
}

// Len returns the number of retained records. It is at most K.
func (r *Reservoir) Len() int {
	if r == nil {
		return 0
	}
	r.mu.Lock()
	defer r.mu.Unlock()
	return len(r.heap)
}

// Err returns the construction error, if any.
func (r *Reservoir) Err() error {
	if r == nil {
		return ErrNilReservoir
	}
	r.mu.Lock()
	defer r.mu.Unlock()
	return r.invalidK
}

// Add inserts a record. An optional value may be supplied as the third
// argument. Re-adding an existing id with the same weight is a no-op, so record
// replay cannot increase its selection probability. Re-adding an id with a
// different weight is rejected with ErrConflictingWeight.
//
// Non-positive and NaN weights are rejected with ErrInvalidWeight.
func (r *Reservoir) Add(id string, weight float64, value ...any) error {
	var v any
	if len(value) > 1 {
		return ErrTooManyValues
	}
	if len(value) == 1 {
		v = value[0]
	}
	return r.add(Record{ID: id, Weight: weight, Value: v})
}

// AddWithValue inserts a record together with an associated value.
func (r *Reservoir) AddWithValue(id string, weight float64, value any) error {
	return r.add(Record{ID: id, Weight: weight, Value: value})
}

// AddRecord inserts rec. Any Priority already present on rec is ignored and
// recomputed from rec.ID and rec.Weight.
func (r *Reservoir) AddRecord(rec Record) error {
	return r.add(rec)
}

// Insert is an alias for AddRecord.
func (r *Reservoir) Insert(rec Record) error {
	return r.add(rec)
}

// AddAll inserts all records in order and stops at the first error.
func (r *Reservoir) AddAll(records []Record) error {
	for _, rec := range records {
		if err := r.add(rec); err != nil {
			return err
		}
	}
	return nil
}

func (r *Reservoir) add(rec Record) error {
	if r == nil {
		return ErrNilReservoir
	}
	r.mu.Lock()
	defer r.mu.Unlock()

	if r.k <= 0 {
		if r.invalidK != nil {
			return r.invalidK
		}
		return fmt.Errorf("%w: %d", ErrInvalidK, r.k)
	}
	if err := ValidateWeight(rec.Weight); err != nil {
		return err
	}
	if r.byID == nil {
		r.byID = make(map[string]Record, r.k)
	}

	if existing, ok := r.byID[rec.ID]; ok {
		if existing.Weight != rec.Weight {
			return fmt.Errorf("%w: id %q (existing %v, new %v)",
				ErrConflictingWeight, rec.ID, existing.Weight, rec.Weight)
		}
		return nil
	}

	priority, err := Priority(rec.ID, rec.Weight)
	if err != nil {
		return err
	}
	rec.Priority = priority

	if len(r.heap) < r.k {
		heap.Push(&r.heap, rec)
		r.byID[rec.ID] = rec
		return nil
	}

	worst := r.heap[0]
	if !betterRecord(rec, worst) {
		return nil
	}
	evicted := heap.Pop(&r.heap).(Record)
	delete(r.byID, evicted.ID)
	heap.Push(&r.heap, rec)
	r.byID[rec.ID] = rec
	return nil
}

// TopK returns retained records ordered best-first. With no argument it
// returns all retained records. An optional k limits the result without
// changing the reservoir.
func (r *Reservoir) TopK(k ...int) []Record {
	if r == nil {
		return []Record{}
	}
	r.mu.Lock()
	out := make([]Record, len(r.heap))
	copy(out, r.heap)
	r.mu.Unlock()

	sort.Slice(out, func(i, j int) bool {
		return betterRecord(out[i], out[j])
	})
	if len(k) > 0 {
		n := k[0]
		if n < 0 {
			n = 0
		}
		if n < len(out) {
			out = out[:n]
		}
	}
	return out
}

// Items is an alias for TopK.
func (r *Reservoir) Items() []Record { return r.TopK() }

// Records is an alias for TopK.
func (r *Reservoir) Records() []Record { return r.TopK() }

// Sorted is an alias for TopK.
func (r *Reservoir) Sorted() []Record { return r.TopK() }

// Reset removes all retained records while preserving the capacity.
func (r *Reservoir) Reset() {
	if r == nil {
		return
	}
	r.mu.Lock()
	defer r.mu.Unlock()
	if r.k > 0 {
		r.byID = make(map[string]Record, r.k)
	} else {
		r.byID = nil
	}
	r.heap = nil
}

// Merge merges r with others. All reservoirs must have the same capacity.
func (r *Reservoir) Merge(others ...*Reservoir) (*Reservoir, error) {
	all := make([]*Reservoir, 0, len(others)+1)
	all = append(all, r)
	all = append(all, others...)
	return Merge(all...)
}

// CompareRecords orders two records best-first. It returns a negative number
// when a should be retained before b, zero when they are the same rank, and a
// positive number otherwise. Higher priority wins; equal priorities are broken
// by ascending unique ID.
func CompareRecords(a, b Record) int {
	switch {
	case a.Priority > b.Priority:
		return -1
	case a.Priority < b.Priority:
		return 1
	case math.IsNaN(a.Priority) && !math.IsNaN(b.Priority):
		return 1
	case !math.IsNaN(a.Priority) && math.IsNaN(b.Priority):
		return -1
	}
	switch {
	case a.ID < b.ID:
		return -1
	case a.ID > b.ID:
		return 1
	default:
		return 0
	}
}

// BetterRecord reports whether a ranks before b.
func BetterRecord(a, b Record) bool {
	return CompareRecords(a, b) < 0
}

func betterRecord(a, b Record) bool {
	return CompareRecords(a, b) < 0
}

func worseRecord(a, b Record) bool {
	return CompareRecords(a, b) > 0
}

// recordHeap is a min-heap where the root is the worst retained record.
type recordHeap []Record

func (h recordHeap) Len() int           { return len(h) }
func (h recordHeap) Less(i, j int) bool { return worseRecord(h[i], h[j]) }
func (h recordHeap) Swap(i, j int)      { h[i], h[j] = h[j], h[i] }

func (h *recordHeap) Push(x any) {
	*h = append(*h, x.(Record))
}

func (h *recordHeap) Pop() any {
	old := *h
	n := len(old)
	item := old[n-1]
	old[n-1] = Record{}
	*h = old[:n-1]
	return item
}
