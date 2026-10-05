// Package runseq implements a sequence stored as runs of contiguous equal
// values (run-length encoding). It supports insert, delete and replace
// operations whose coordinates refer to the current (logical) sequence, and
// every mutating operation returns an inverse operation that undoes it.
// Adjacent runs with equal values are always merged. All lengths and offsets
// are int64 and arithmetic is checked against overflow.
package runseq

import (
	"errors"
	"fmt"
	"math"
)

var (
	// ErrOutOfRange is returned when an offset or length falls outside the
	// current sequence.
	ErrOutOfRange = errors.New("runseq: offset/length out of range")
	// ErrOverflow is returned when an operation would make the sequence
	// length overflow int64.
	ErrOverflow = errors.New("runseq: length overflow")
	// ErrTooLarge is returned when an operation would have to materialize
	// more values than can be held in memory (e.g. the inverse of a Delete
	// must contain every removed value).
	ErrTooLarge = errors.New("runseq: range too large to materialize")
)

// maxMaterialize bounds how many values a single operation may expand into
// a slice (removed values for Delete/Replace, flattened output for Slice).
const maxMaterialize = int64(math.MaxInt32)

// OpKind identifies the kind of an Op.
type OpKind int

const (
	OpInsert OpKind = iota
	OpDelete
	OpReplace
)

func (k OpKind) String() string {
	switch k {
	case OpInsert:
		return "Insert"
	case OpDelete:
		return "Delete"
	case OpReplace:
		return "Replace"
	}
	return "Unknown"
}

// Op describes a single edit. Coordinates refer to the sequence as it is at
// the moment the op is applied.
//
//   - OpInsert: insert Values at Off.
//   - OpDelete: delete Len elements starting at Off.
//   - OpReplace: overwrite len(Values) elements starting at Off with Values.
type Op[T comparable] struct {
	Kind   OpKind
	Off    int64
	Len    int64 // OpDelete only
	Values []T   // OpInsert and OpReplace only
}

func (op Op[T]) String() string {
	switch op.Kind {
	case OpDelete:
		return fmt.Sprintf("Delete(off=%d, len=%d)", op.Off, op.Len)
	default:
		return fmt.Sprintf("%s(off=%d, values=%v)", op.Kind, op.Off, op.Values)
	}
}

// run is one maximal segment of equal values.
type run[T comparable] struct {
	val T
	n   int64
}

// Seq is a run-length encoded sequence of values.
type Seq[T comparable] struct {
	runs  []run[T]
	total int64
}

// New returns an empty sequence.
func New[T comparable]() *Seq[T] { return &Seq[T]{} }

// FromSlice builds a sequence from vals, merging adjacent equal values.
func FromSlice[T comparable](vals []T) *Seq[T] {
	s := &Seq[T]{total: int64(len(vals))}
	for _, v := range vals {
		s.runs = appendVal(s.runs, v)
	}
	return s
}

// Len returns the number of elements in the sequence.
func (s *Seq[T]) Len() int64 { return s.total }

// Runs returns the number of runs currently stored.
func (s *Seq[T]) Runs() int { return len(s.runs) }

// At returns the value at logical offset off. It panics if off is out of
// range.
func (s *Seq[T]) At(off int64) T {
	if off < 0 || off >= s.total {
		panic(fmt.Sprintf("runseq: At(%d) out of range (len=%d)", off, s.total))
	}
	for _, r := range s.runs {
		if off < r.n {
			return r.val
		}
		off -= r.n
	}
	panic("runseq: inconsistent run totals")
}

// Slice flattens the sequence into a plain slice. Callers must ensure the
// sequence length fits in memory; it panics if the length exceeds
// maxMaterialize.
func (s *Seq[T]) Slice() []T {
	if s.total > maxMaterialize {
		panic("runseq: sequence too large to flatten")
	}
	out := make([]T, 0, int(s.total))
	for _, r := range s.runs {
		for i := int64(0); i < r.n; i++ {
			out = append(out, r.val)
		}
	}
	return out
}

// checkRange validates that [off, off+n) is a valid range of the current
// sequence. The arithmetic is overflow-safe.
func (s *Seq[T]) checkRange(off, n int64) error {
	if off < 0 || n < 0 || off > s.total || n > s.total-off {
		return fmt.Errorf("%w: off=%d n=%d len=%d", ErrOutOfRange, off, n, s.total)
	}
	return nil
}

// Insert inserts vals at offset off and returns the inverse op.
func (s *Seq[T]) Insert(off int64, vals []T) (Op[T], error) {
	return s.Apply(Op[T]{Kind: OpInsert, Off: off, Values: vals})
}

// Delete removes n elements starting at off and returns the inverse op.
func (s *Seq[T]) Delete(off, n int64) (Op[T], error) {
	return s.Apply(Op[T]{Kind: OpDelete, Off: off, Len: n})
}

// Replace overwrites len(vals) elements starting at off with vals and
// returns the inverse op.
func (s *Seq[T]) Replace(off int64, vals []T) (Op[T], error) {
	return s.Apply(Op[T]{Kind: OpReplace, Off: off, Values: vals})
}

// Apply performs op on the current sequence and returns the inverse op,
// which restores the previous state when applied to the resulting sequence.
func (s *Seq[T]) Apply(op Op[T]) (Op[T], error) {
	switch op.Kind {
	case OpInsert:
		if err := s.checkRange(op.Off, 0); err != nil {
			return Op[T]{}, err
		}
		add := int64(len(op.Values))
		if add > math.MaxInt64-s.total {
			return Op[T]{}, fmt.Errorf("%w: len=%d add=%d", ErrOverflow, s.total, add)
		}
		s.splice(op.Off, 0, op.Values)
		return Op[T]{Kind: OpDelete, Off: op.Off, Len: add}, nil

	case OpDelete:
		if err := s.checkRange(op.Off, op.Len); err != nil {
			return Op[T]{}, err
		}
		if op.Len > maxMaterialize {
			return Op[T]{}, fmt.Errorf("%w: delete of %d values", ErrTooLarge, op.Len)
		}
		removed := s.splice(op.Off, op.Len, nil)
		return Op[T]{Kind: OpInsert, Off: op.Off, Values: removed}, nil

	case OpReplace:
		if err := s.checkRange(op.Off, int64(len(op.Values))); err != nil {
			return Op[T]{}, err
		}
		removed := s.splice(op.Off, int64(len(op.Values)), op.Values)
		return Op[T]{Kind: OpReplace, Off: op.Off, Values: removed}, nil
	}
	return Op[T]{}, fmt.Errorf("runseq: unknown op kind %d", int(op.Kind))
}

// splice replaces the range [off, off+delN) with vals, keeping runs merged,
// and returns the removed values. Callers must have validated the range and
// the total-length overflow beforehand.
func (s *Seq[T]) splice(off, delN int64, vals []T) []T {
	left, rest := splitRuns(s.runs, off)
	mid, right := splitRuns(rest, delN)

	removed := make([]T, 0, delN)
	for _, r := range mid {
		for i := int64(0); i < r.n; i++ {
			removed = append(removed, r.val)
		}
	}

	merged := left
	for _, v := range vals {
		merged = appendVal(merged, v)
	}
	for _, r := range right {
		merged = appendRun(merged, r)
	}
	s.runs = merged
	s.total = s.total - delN + int64(len(vals))
	return removed
}

// splitRuns splits runs at logical offset off into a left and right part.
// The run straddling off, if any, is divided in two.
func splitRuns[T comparable](runs []run[T], off int64) (left, right []run[T]) {
	rem := off
	for _, r := range runs {
		switch {
		case rem <= 0:
			right = append(right, r)
		case r.n <= rem:
			left = append(left, r)
			rem -= r.n
		default:
			left = append(left, run[T]{val: r.val, n: rem})
			right = append(right, run[T]{val: r.val, n: r.n - rem})
			rem = 0
		}
	}
	return left, right
}

// appendVal appends a single value, merging with the last run when equal.
func appendVal[T comparable](runs []run[T], v T) []run[T] {
	return appendRun(runs, run[T]{val: v, n: 1})
}

// appendRun appends a run, merging with the last run when values are equal.
func appendRun[T comparable](runs []run[T], r run[T]) []run[T] {
	if r.n == 0 {
		return runs
	}
	if n := len(runs); n > 0 && runs[n-1].val == r.val {
		runs[n-1].n += r.n
		return runs
	}
	return append(runs, r)
}
