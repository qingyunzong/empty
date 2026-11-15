package dataeng

import (
	"errors"
	"fmt"
	"strings"
)

// Bound is one end of a key range. A nil Value means the end is unbounded.
// Inclusive is significant only when Value is non-nil.
type Bound struct {
	Value     Tuple
	Inclusive bool
}

// Unbounded returns an open-ended bound.
func Unbounded() Bound { return Bound{} }

// InclusiveKey returns a closed (inclusive) bound at key.
func InclusiveKey(key Tuple) Bound { return Bound{Value: key, Inclusive: true} }

// ExclusiveKey returns an open (exclusive) bound at key.
func ExclusiveKey(key Tuple) Bound { return Bound{Value: key, Inclusive: false} }

// IsUnbounded reports whether the bound extends to infinity.
func (b Bound) IsUnbounded() bool { return b.Value == nil }

func (b Bound) String() string {
	if b.IsUnbounded() {
		return "<unbounded>"
	}
	op := ">"
	if b.Inclusive {
		op = ">="
	}
	return op + " " + FormatTuple(b.Value)
}

// Chunk is a half-open primary-key range [Lower, Upper). A nil Lower or Upper
// value is unbounded. Plans built by BuildPlan always use inclusive lower and
// exclusive upper bounds, so adjacent chunks neither overlap nor leave a gap.
type Chunk struct {
	Table string
	Index int
	Lower Bound
	Upper Bound
}

func (c Chunk) String() string {
	lower, upper := "(-inf", "+inf)"
	if !c.Lower.IsUnbounded() {
		lower = "[" + FormatTuple(c.Lower.Value)
		if !c.Lower.Inclusive {
			lower = "(" + FormatTuple(c.Lower.Value)
		}
	}
	if !c.Upper.IsUnbounded() {
		upper = FormatTuple(c.Upper.Value) + ")"
		if c.Upper.Inclusive {
			upper = FormatTuple(c.Upper.Value) + "]"
		}
	}
	return fmt.Sprintf("%s %s, %s", c.Table, lower, upper)
}

// Contains reports whether key belongs to the chunk according to cols.
func (c Chunk) Contains(key Tuple, cols []KeyColumn) (bool, error) {
	if !c.Lower.IsUnbounded() {
		cmp, err := CompareTuples(key, c.Lower.Value, cols)
		if err != nil {
			return false, err
		}
		if cmp < 0 || (cmp == 0 && !c.Lower.Inclusive) {
			return false, nil
		}
	}
	if !c.Upper.IsUnbounded() {
		cmp, err := CompareTuples(key, c.Upper.Value, cols)
		if err != nil {
			return false, err
		}
		if cmp > 0 || (cmp == 0 && !c.Upper.Inclusive) {
			return false, nil
		}
	}
	return true, nil
}

// ValidateColumns checks the static description of a primary key.
func ValidateColumns(cols []KeyColumn) error {
	if len(cols) == 0 {
		return fmt.Errorf("%w: no primary-key columns", ErrInvalidKey)
	}
	seen := make(map[string]struct{}, len(cols))
	for i, col := range cols {
		if strings.TrimSpace(col.Name) == "" {
			return fmt.Errorf("%w: key column %d has an empty name", ErrInvalidKey, i)
		}
		if _, ok := seen[col.Name]; ok {
			return fmt.Errorf("%w: duplicate key column %q", ErrInvalidKey, col.Name)
		}
		seen[col.Name] = struct{}{}
		if col.Nulls != NullsLast && col.Nulls != NullsFirst {
			return fmt.Errorf("%w: column %q has invalid null order %d",
				ErrInvalidKey, col.Name, col.Nulls)
		}
		if col.Kind > KindTime {
			return fmt.Errorf("%w: column %q has invalid kind %d",
				ErrInvalidKey, col.Name, col.Kind)
		}
	}
	return nil
}

// ValidateChunks checks that chunks are ordered, half-open and cover the whole
// key space without gaps or overlap.
func ValidateChunks(chunks []Chunk, cols []KeyColumn) error {
	if err := ValidateColumns(cols); err != nil {
		return err
	}
	if len(chunks) == 0 {
		return fmt.Errorf("%w: plan has no chunks", ErrInvalidPlan)
	}

	table := chunks[0].Table
	for i, chunk := range chunks {
		if chunk.Table == "" {
			return fmt.Errorf("%w: chunk %d has an empty table", ErrInvalidPlan, i)
		}
		if chunk.Table != table {
			return fmt.Errorf("%w: chunk %d belongs to %q, want %q",
				ErrInvalidPlan, i, chunk.Table, table)
		}
		if chunk.Index != i {
			return fmt.Errorf("%w: chunk %d has index %d", ErrInvalidPlan, i, chunk.Index)
		}
		if !chunk.Lower.IsUnbounded() {
			if len(chunk.Lower.Value) != len(cols) {
				return fmt.Errorf("%w: chunk %d lower key has %d values, want %d",
					ErrInvalidPlan, i, len(chunk.Lower.Value), len(cols))
			}
			if !chunk.Lower.Inclusive {
				return fmt.Errorf("%w: chunk %d has an exclusive lower bound; "+
					"chunks must be half-open [lower, upper)", ErrInvalidPlan, i)
			}
		}
		if !chunk.Upper.IsUnbounded() {
			if len(chunk.Upper.Value) != len(cols) {
				return fmt.Errorf("%w: chunk %d upper key has %d values, want %d",
					ErrInvalidPlan, i, len(chunk.Upper.Value), len(cols))
			}
			if chunk.Upper.Inclusive {
				return fmt.Errorf("%w: chunk %d has an inclusive upper bound; "+
					"chunks must be half-open [lower, upper)", ErrInvalidPlan, i)
			}
		}
		if !chunk.Lower.IsUnbounded() && !chunk.Upper.IsUnbounded() {
			cmp, err := CompareTuples(chunk.Lower.Value, chunk.Upper.Value, cols)
			if err != nil {
				return fmt.Errorf("chunk %d: %w", i, err)
			}
			if cmp >= 0 {
				return fmt.Errorf("%w: chunk %d is empty (%s, %s)",
					ErrInvalidPlan, i, chunk.Lower, chunk.Upper)
			}
		}
	}

	if !chunks[0].Lower.IsUnbounded() {
		return fmt.Errorf("%w: first chunk does not start at negative infinity", ErrInvalidPlan)
	}
	if !chunks[len(chunks)-1].Upper.IsUnbounded() {
		return fmt.Errorf("%w: last chunk does not end at positive infinity", ErrInvalidPlan)
	}

	for i := 1; i < len(chunks); i++ {
		prev, next := chunks[i-1], chunks[i]
		if prev.Upper.IsUnbounded() || next.Lower.IsUnbounded() {
			return fmt.Errorf("%w: unbounded bound inside plan at chunk %d", ErrInvalidPlan, i)
		}
		cmp, err := CompareTuples(prev.Upper.Value, next.Lower.Value, cols)
		if err != nil {
			return fmt.Errorf("chunks %d/%d: %w", i-1, i, err)
		}
		if cmp != 0 {
			return fmt.Errorf("%w: gap or overlap between chunks %d and %d",
				ErrInvalidPlan, i-1, i)
		}
		if prev.Upper.Inclusive || !next.Lower.Inclusive {
			return fmt.Errorf("%w: boundary between chunks %d and %d is not half-open",
				ErrInvalidPlan, i-1, i)
		}
	}
	return nil
}

var (
	// ErrInvalidPlan reports chunks that do not form an ordered partition.
	ErrInvalidPlan = errors.New("dataeng: invalid chunk plan")
)
