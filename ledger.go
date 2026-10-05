// Package ledger maintains signed fee entries ordered by (time, ID) on two
// axes (business time and submission time), and answers cumulative-sum and
// first-over-budget queries against atomically published snapshots.
package ledger

import (
	"errors"
	"fmt"
	"sort"
)

// Axis selects which clock a cumulative query walks along.
type Axis int

const (
	// BusinessTime orders entries by (Business, ID).
	BusinessTime Axis = iota
	// SubmitTime orders entries by (Submit, ID).
	SubmitTime
)

func (a Axis) String() string {
	if a == BusinessTime {
		return "business"
	}
	return "submit"
}

// Entry is a single signed fee record. Fees are integer minor units.
type Entry struct {
	ID       uint64
	Batch    uint64
	Business int64  // business (value) time
	Submit   int64  // submission (system) time
	Fee      int64  // signed
	Reversal bool   // true for offsetting entries created by Reverse
	Reverses uint64 // ID of the entry this reversal offsets; 0 if none
	Voided   bool   // deactivated in place; only allowed before the batch locks
}

var (
	ErrNotFound    = errors.New("ledger: entry not found")
	ErrBatchLocked = errors.New("ledger: batch is locked; use Reverse to post an offsetting batch")
	ErrDuplicateID = errors.New("ledger: duplicate entry ID")
	ErrReversalOf  = errors.New("ledger: entry already reversed")
	ErrVoided      = errors.New("ledger: entry is voided")
)

// key is the sort key of an entry on one axis: (time, ID).
type key struct {
	t  int64
	id uint64
}

// Evidence is verifiable proof of a prefix of the ledger on one axis.
// The empty prefix has Cumulative == 0, Count == 0 and Hash == offsetBasis.
type Evidence struct {
	Axis       Axis
	Index      int    // position in axis order; -1 for the empty prefix
	EntryID    uint64 // entry at Index; 0 for the empty prefix
	Count      int    // number of active entries in the prefix
	Cumulative int64  // sum of fees in the prefix
	Hash       uint64 // FNV-1a fold over the prefix, in axis order
}

const offsetBasis uint64 = 14695981039346656037
const fnvPrime uint64 = 1099511628211

func fold(h uint64, v uint64) uint64 {
	for i := 0; i < 8; i++ {
		h ^= uint64(byte(v))
		h *= fnvPrime
		v >>= 8
	}
	return h
}

func hashEntry(h uint64, e Entry) uint64 {
	h = fold(h, e.ID)
	h = fold(h, uint64(e.Business))
	h = fold(h, uint64(e.Submit))
	h = fold(h, uint64(e.Fee))
	return h
}

// segTree is a segment tree over signed fees storing, per node, the segment
// sum and the maximum prefix sum inside the segment. It locates the first
// position whose running total exceeds a budget in O(log n), which stays
// correct in the presence of negative fees where binary search would not.
type segTree struct {
	n      int
	size   int
	sum    []int64
	maxPre []int64
}

func newSegTree(vals []int64) *segTree {
	n := len(vals)
	size := 1
	for size < n {
		size <<= 1
	}
	if size == 0 {
		size = 1
	}
	t := &segTree{n: n, size: size, sum: make([]int64, 2*size), maxPre: make([]int64, 2*size)}
	for i := 0; i < size; i++ {
		v := int64(0)
		if i < n {
			v = vals[i]
		}
		t.sum[size+i] = v
		t.maxPre[size+i] = v
	}
	for i := size - 1; i >= 1; i-- {
		l, r := 2*i, 2*i+1
		t.sum[i] = t.sum[l] + t.sum[r]
		if t.sum[l]+t.maxPre[r] > t.maxPre[l] {
			t.maxPre[i] = t.sum[l] + t.maxPre[r]
		} else {
			t.maxPre[i] = t.maxPre[l]
		}
	}
	return t
}

// firstExceeding returns the smallest index whose prefix sum (of indices
// 0..i) is strictly greater than budget, or -1 if there is none.
func (t *segTree) firstExceeding(budget int64) int {
	if t.n == 0 || t.maxPre[1] <= budget {
		return -1
	}
	idx := 1
	acc := int64(0)
	for idx < t.size {
		left := 2 * idx
		if acc+t.maxPre[left] > budget {
			idx = left
		} else {
			acc += t.sum[left]
			idx = left + 1
		}
	}
	pos := idx - t.size
	if pos >= t.n {
		return -1
	}
	return pos
}

// axisIndex is one immutable ordering of the active entries plus its prefix
// structures.
type axisIndex struct {
	ids    []uint64
	fees   []int64
	prefix []int64  // prefix[i] = sum of fees[0..i]
	hashes []uint64 // hashes[i] = fold of entries[0..i]
	posOf  map[uint64]int
	tree   *segTree
	total  int64
}

func buildAxis(entries []Entry, axis Axis) *axisIndex {
	sorted := make([]Entry, len(entries))
	copy(sorted, entries)
	sort.Slice(sorted, func(i, j int) bool {
		var ki, kj key
		if axis == BusinessTime {
			ki, kj = key{sorted[i].Business, sorted[i].ID}, key{sorted[j].Business, sorted[j].ID}
		} else {
			ki, kj = key{sorted[i].Submit, sorted[i].ID}, key{sorted[j].Submit, sorted[j].ID}
		}
		if ki.t != kj.t {
			return ki.t < kj.t
		}
		return ki.id < kj.id
	})
	ai := &axisIndex{
		ids:    make([]uint64, len(sorted)),
		fees:   make([]int64, len(sorted)),
		prefix: make([]int64, len(sorted)),
		hashes: make([]uint64, len(sorted)),
		posOf:  make(map[uint64]int, len(sorted)),
	}
	run := int64(0)
	h := offsetBasis
	for i, e := range sorted {
		run += e.Fee
		h = hashEntry(h, e)
		ai.ids[i] = e.ID
		ai.fees[i] = e.Fee
		ai.prefix[i] = run
		ai.hashes[i] = h
		ai.posOf[e.ID] = i
	}
	ai.tree = newSegTree(ai.fees)
	ai.total = run
	return ai
}

// Snapshot is an immutable, atomically published view of the ledger.
type Snapshot struct {
	entries map[uint64]Entry
	locked  map[uint64]bool
	seq     uint64
	axes    [2]*axisIndex
}

// Seq is the publication sequence number of the snapshot.
func (s *Snapshot) Seq() uint64 { return s.seq }

// Total returns the sum of all active fees on the given axis (identical on
// both axes; provided per-axis for symmetry with prefix queries).
func (s *Snapshot) Total(axis Axis) int64 { return s.axes[axis].total }

// Len returns the number of active entries.
func (s *Snapshot) Len() int { return len(s.entries) }

// Entry returns a copy of the entry with the given ID.
func (s *Snapshot) Entry(id uint64) (Entry, bool) {
	e, ok := s.entries[id]
	return e, ok
}

// Locked reports whether a batch has been locked.
func (s *Snapshot) Locked(batch uint64) bool { return s.locked[batch] }

// Cumulative returns the running total on the given axis up to and including
// the entry with the given ID. The empty prefix is 0: an ID that is not
// present yields (0, false).
func (s *Snapshot) Cumulative(axis Axis, id uint64) (int64, bool) {
	pos, ok := s.axes[axis].posOf[id]
	if !ok {
		return 0, false
	}
	return s.axes[axis].prefix[pos], true
}

// EvidenceAt returns prefix evidence ending at (and including) the entry
// with the given ID on the given axis.
func (s *Snapshot) EvidenceAt(axis Axis, id uint64) (Evidence, bool) {
	pos, ok := s.axes[axis].posOf[id]
	if !ok {
		return Evidence{}, false
	}
	return Evidence{
		Axis:       axis,
		Index:      pos,
		EntryID:    id,
		Count:      pos + 1,
		Cumulative: s.axes[axis].prefix[pos],
		Hash:       s.axes[axis].hashes[pos],
	}, true
}

// EvidenceHead returns evidence for the empty prefix: Cumulative 0, Count 0.
func (s *Snapshot) EvidenceHead(axis Axis) Evidence {
	return Evidence{Axis: axis, Index: -1, Cumulative: 0, Count: 0, Hash: offsetBasis}
}

// FirstExceeding returns evidence for the first prefix on the given axis
// whose cumulative sum is strictly greater than budget. ok is false when no
// prefix exceeds the budget.
func (s *Snapshot) FirstExceeding(axis Axis, budget int64) (ev Evidence, ok bool) {
	ai := s.axes[axis]
	pos := ai.tree.firstExceeding(budget)
	if pos < 0 {
		return Evidence{}, false
	}
	return Evidence{
		Axis:       axis,
		Index:      pos,
		EntryID:    ai.ids[pos],
		Count:      pos + 1,
		Cumulative: ai.prefix[pos],
		Hash:       ai.hashes[pos],
	}, true
}

// ScanEvidence recomputes prefix evidence by walking the axis entry by
// entry. It is the ground truth against which the index is audited.
func (s *Snapshot) ScanEvidence(axis Axis, budget int64) (first Evidence, hasFirst bool, total int64, count int) {
	ai := s.axes[axis]
	run := int64(0)
	h := offsetBasis
	for i, id := range ai.ids {
		e := s.entries[id]
		run += e.Fee
		h = hashEntry(h, e)
		if !hasFirst && run > budget {
			hasFirst = true
			first = Evidence{Axis: axis, Index: i, EntryID: id, Count: i + 1, Cumulative: run, Hash: h}
		}
	}
	return first, hasFirst, run, len(ai.ids)
}

// Audit recomputes the full ledger on both axes by item-by-item scan and
// checks the published index against it: every prefix sum and hash, and the
// first-over-budget evidence for a spread of budgets.
func (s *Snapshot) Audit() error {
	for _, axis := range []Axis{BusinessTime, SubmitTime} {
		ai := s.axes[axis]
		run := int64(0)
		h := offsetBasis
		for i, id := range ai.ids {
			e, ok := s.entries[id]
			if !ok {
				return fmt.Errorf("audit %s: index references unknown entry %d", axis, id)
			}
			run += e.Fee
			h = hashEntry(h, e)
			if ai.prefix[i] != run {
				return fmt.Errorf("audit %s: prefix[%d]=%d, scan=%d", axis, i, ai.prefix[i], run)
			}
			if ai.hashes[i] != h {
				return fmt.Errorf("audit %s: hash[%d] mismatch", axis, i)
			}
		}
		if ai.total != run {
			return fmt.Errorf("audit %s: total=%d, scan=%d", axis, ai.total, run)
		}
		// Probe budgets around the running totals seen on this axis.
		budgets := map[int64]bool{0: true, ai.total: true, ai.total - 1: true}
		for _, p := range ai.prefix {
			budgets[p] = true
			budgets[p-1] = true
		}
		for b := range budgets {
			ev, ok := s.FirstExceeding(axis, b)
			want, wantOK, _, _ := s.ScanEvidence(axis, b)
			if ok != wantOK {
				return fmt.Errorf("audit %s: firstExceeding(%d) ok=%v, scan ok=%v", axis, b, ok, wantOK)
			}
			if ok && ev != want {
				return fmt.Errorf("audit %s: firstExceeding(%d)=%+v, scan=%+v", axis, b, ev, want)
			}
		}
	}
	return nil
}
