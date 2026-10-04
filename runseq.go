// Package runseq implements a sequence store based on run-length encoded
// intervals (spans of equal values). It supports insert, delete and replace
// operations whose coordinates refer to the current (already modified)
// sequence, and every mutating operation returns an inverse operation that
// restores the previous state. Adjacent spans holding equal values are
// always merged. All lengths and offsets are int64 and arithmetic is
// checked against overflow.
package runseq

import (
	"errors"
	"fmt"
	"math"
)

// Span is a maximal run of Len consecutive elements equal to Value.
type Span[T comparable] struct {
	Value T
	Len   int64
}

// OpKind identifies the kind of an Operation.
type OpKind int

const (
	OpInsert OpKind = iota
	OpDelete
	OpReplace
)

func (k OpKind) String() string {
	switch k {
	case OpInsert:
		return "insert"
	case OpDelete:
		return "delete"
	case OpReplace:
		return "replace"
	}
	return "unknown"
}

// Operation describes a single edit. Coordinates are interpreted against
// the state of the store at the moment the operation is applied.
//
//   - OpInsert:  insert Spans at Off.
//   - OpDelete:  delete Len elements starting at Off.
//   - OpReplace: replace sumLen(Spans) elements starting at Off with Spans.
type Operation[T comparable] struct {
	Kind  OpKind
	Off   int64
	Spans []Span[T] // payload for OpInsert and OpReplace
	Len   int64     // payload for OpDelete
}

var (
	ErrOutOfRange = errors.New("runseq: offset or length out of range")
	ErrOverflow   = errors.New("runseq: length overflow")
	ErrBadOp      = errors.New("runseq: invalid operation")
)

// Store is a run-length encoded sequence of values.
type Store[T comparable] struct {
	spans []Span[T]
	total int64
}

// New returns an empty Store.
func New[T comparable]() *Store[T] { return &Store[T]{} }

// Len returns the total number of elements in the sequence.
func (s *Store[T]) Len() int64 { return s.total }

// SpanCount returns the number of runs currently stored.
func (s *Store[T]) SpanCount() int { return len(s.spans) }

// Spans returns a copy of the internal run-length encoding.
func (s *Store[T]) Spans() []Span[T] {
	out := make([]Span[T], len(s.spans))
	copy(out, s.spans)
	return out
}

// At returns the element at logical offset i.
func (s *Store[T]) At(i int64) (T, bool) {
	var zero T
	if i < 0 || i >= s.total {
		return zero, false
	}
	for _, sp := range s.spans {
		if i < sp.Len {
			return sp.Value, true
		}
		i -= sp.Len
	}
	return zero, false
}

// Collect flattens the whole sequence into a slice. Intended for small
// sequences (e.g. tests); it allocates Len() elements.
func (s *Store[T]) Collect() []T {
	out := make([]T, 0, s.total)
	for _, sp := range s.spans {
		for i := int64(0); i < sp.Len; i++ {
			out = append(out, sp.Value)
		}
	}
	return out
}

// Slice returns the elements in [off, off+n).
func (s *Store[T]) Slice(off, n int64) ([]T, error) {
	if err := s.checkRange(off, n); err != nil {
		return nil, err
	}
	out := make([]T, 0, n)
	rem := off
	for _, sp := range s.spans {
		if n == 0 {
			break
		}
		if rem >= sp.Len {
			rem -= sp.Len
			continue
		}
		take := sp.Len - rem
		if take > n {
			take = n
		}
		for i := int64(0); i < take; i++ {
			out = append(out, sp.Value)
		}
		n -= take
		rem = 0
	}
	return out, nil
}

func (s *Store[T]) checkRange(off, n int64) error {
	if off < 0 || n < 0 || off > s.total || n > s.total-off {
		return fmt.Errorf("%w: off=%d n=%d len=%d", ErrOutOfRange, off, n, s.total)
	}
	return nil
}

// sumLen adds span lengths with overflow checking.
func sumLen[T comparable](spans []Span[T]) (int64, error) {
	var total int64
	for _, sp := range spans {
		if sp.Len < 0 || sp.Len > math.MaxInt64-total {
			return 0, ErrOverflow
		}
		total += sp.Len
	}
	return total, nil
}

// spansOf converts a flat slice into normalized spans.
func spansOf[T comparable](values []T) []Span[T] {
	var out []Span[T]
	for _, v := range values {
		if n := len(out); n > 0 && out[n-1].Value == v {
			out[n-1].Len++
		} else {
			out = append(out, Span[T]{Value: v, Len: 1})
		}
	}
	return out
}

// normalize merges adjacent equal-valued spans and drops empty ones.
func normalize[T comparable](spans []Span[T]) []Span[T] {
	out := spans[:0]
	for _, sp := range spans {
		if sp.Len <= 0 {
			continue
		}
		if n := len(out); n > 0 && out[n-1].Value == sp.Value {
			out[n-1].Len += sp.Len
		} else {
			out = append(out, sp)
		}
	}
	return out
}

// splitSpans divides spans at logical offset off (0 <= off <= total),
// returning the parts covering [0, off) and [off, total).
func splitSpans[T comparable](spans []Span[T], off int64) (pre, suf []Span[T]) {
	rem := off
	for _, sp := range spans {
		switch {
		case rem <= 0:
			suf = append(suf, sp)
		case rem >= sp.Len:
			pre = append(pre, sp)
			rem -= sp.Len
		default:
			pre = append(pre, Span[T]{Value: sp.Value, Len: rem})
			suf = append(suf, Span[T]{Value: sp.Value, Len: sp.Len - rem})
			rem = 0
		}
	}
	return pre, suf
}

// splice removes the range [off, off+removeLen) and inserts ins at off,
// returning the removed spans. The result is normalized so adjacent equal
// values are merged.
func (s *Store[T]) splice(off, removeLen int64, ins []Span[T]) ([]Span[T], error) {
	if err := s.checkRange(off, removeLen); err != nil {
		return nil, err
	}
	insLen, err := sumLen(ins)
	if err != nil {
		return nil, err
	}
	rest := s.total - removeLen
	if insLen > math.MaxInt64-rest {
		return nil, fmt.Errorf("%w: len %d - %d + %d", ErrOverflow, s.total, removeLen, insLen)
	}

	pre, mid := splitSpans(s.spans, off)
	removed, suf := splitSpans(mid, removeLen)

	merged := make([]Span[T], 0, len(pre)+len(ins)+len(suf))
	merged = append(merged, pre...)
	merged = append(merged, ins...)
	merged = append(merged, suf...)

	s.spans = normalize(merged)
	s.total = rest + insLen
	return removed, nil
}

// Apply performs op and returns its inverse. Applying the returned
// operation to the resulting state restores the previous state exactly.
func (s *Store[T]) Apply(op Operation[T]) (Operation[T], error) {
	switch op.Kind {
	case OpInsert:
		insLen, err := sumLen(op.Spans)
		if err != nil {
			return Operation[T]{}, err
		}
		if _, err := s.splice(op.Off, 0, normalize(append([]Span[T](nil), op.Spans...))); err != nil {
			return Operation[T]{}, err
		}
		return Operation[T]{Kind: OpDelete, Off: op.Off, Len: insLen}, nil
	case OpDelete:
		removed, err := s.splice(op.Off, op.Len, nil)
		if err != nil {
			return Operation[T]{}, err
		}
		return Operation[T]{Kind: OpInsert, Off: op.Off, Spans: removed}, nil
	case OpReplace:
		insLen, err := sumLen(op.Spans)
		if err != nil {
			return Operation[T]{}, err
		}
		removed, err := s.splice(op.Off, insLen, normalize(append([]Span[T](nil), op.Spans...)))
		if err != nil {
			return Operation[T]{}, err
		}
		return Operation[T]{Kind: OpReplace, Off: op.Off, Spans: removed}, nil
	}
	return Operation[T]{}, fmt.Errorf("%w: kind=%d", ErrBadOp, op.Kind)
}

// Insert inserts values at offset off and returns the inverse operation.
func (s *Store[T]) Insert(off int64, values []T) (Operation[T], error) {
	return s.Apply(Operation[T]{Kind: OpInsert, Off: off, Spans: spansOf(values)})
}

// InsertRepeat inserts count copies of value at offset off. It allows
// building very long runs without materializing them.
func (s *Store[T]) InsertRepeat(off int64, value T, count int64) (Operation[T], error) {
	if count < 0 {
		return Operation[T]{}, fmt.Errorf("%w: count=%d", ErrOutOfRange, count)
	}
	var spans []Span[T]
	if count > 0 {
		spans = []Span[T]{{Value: value, Len: count}}
	}
	return s.Apply(Operation[T]{Kind: OpInsert, Off: off, Spans: spans})
}

// Delete removes n elements starting at off and returns the inverse
// operation (an insert carrying the removed data).
func (s *Store[T]) Delete(off, n int64) (Operation[T], error) {
	return s.Apply(Operation[T]{Kind: OpDelete, Off: off, Len: n})
}

// Replace substitutes len(values) elements starting at off with values and
// returns the inverse operation.
func (s *Store[T]) Replace(off int64, values []T) (Operation[T], error) {
	return s.Apply(Operation[T]{Kind: OpReplace, Off: off, Spans: spansOf(values)})
}
