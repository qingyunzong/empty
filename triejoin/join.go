// Package triejoin computes multi-way natural joins over finite relations
// using a worst-case-optimal layered intersection (Leapfrog Trie Join).
//
// The engine never materializes a pairwise intermediate tuple table and never
// enumerates a Cartesian product to filter it. At each global variable it opens
// the next trie level of every relation containing that variable, leapfrogs the
// ordered cursors with seek, and recurses deeper only when all cursors agree.
// Results are produced one tuple at a time in global-variable lexicographic
// order; the consumer may pause after any tuple and resume later, or cancel the
// join to close every cursor.
package triejoin

import (
	"context"
	"errors"
	"fmt"
	"sort"
)

// ErrIteratorClosed is returned when Next is called on a closed iterator.
var ErrIteratorClosed = errors.New("triejoin: iterator is closed")

// Relation is one input relation: a unique ID, an ordered list of distinct
// column variable names, and a set of int64 tuples. Tuples must have the same
// arity as Columns; duplicate tuples are treated as a set and deduplicated.
type Relation struct {
	ID      string
	Columns []string
	Tuples  [][]int64
}

// Counts reports the number of cursor operations issued by the join. The
// counters aggregate one TrieIterator per non-zero-arity relation and are safe
// to read while iteration is paused and after Close.
type Counts struct {
	Opens int64
	Seeks int64
	Nexts int64
	Ups   int64
}

// TrieIterator is an ordered trie cursor implemented over one relation.
//
// Navigation follows the trie level of the current variable:
//   - Open enters the child level of the current value;
//   - SeekTo moves at the current level, starting from the current position, to
//     the smallest value not smaller than target (or becomes exhausted);
//   - Next advances to the next distinct value at the current level, or becomes
//     exhausted; implementations must never emulate Seek with repeated Next;
//   - Up returns to the parent level;
//   - At returns the current value (only when Valid reports true).
type TrieIterator interface {
	Open() error
	Up() error
	// SeekTo is the seek operation; its calls are counted in Counts.Seeks.
	SeekTo(target int64) (bool, error)
	Next() (bool, error)
	Valid() bool
	At() int64
	Close() error

	// Counts returns cumulative open/seek/next/up call counts for this cursor.
	Counts() Counts
}

// CursorFactory builds trie iterators for one relation. A fresh iterator must be
// returned for every call. The factory receives an immutable snapshot: the
// columns are already restricted to and ordered by the global variable order,
// and tuples are deduplicated and ordered lexicographically.
type CursorFactory interface {
	NewIterator(snap RelationSnapshot) (TrieIterator, error)
}

// CursorFactoryFunc adapts a function to CursorFactory.
type CursorFactoryFunc func(snap RelationSnapshot) (TrieIterator, error)

// NewIterator implements CursorFactory.
func (f CursorFactoryFunc) NewIterator(snap RelationSnapshot) (TrieIterator, error) {
	return f(snap)
}

// RelationSnapshot is the immutable, globally ordered view of one relation
// handed to a CursorFactory.
type RelationSnapshot struct {
	ID      string
	Columns []string
	Tuples  [][]int64
}

// Option configures a join.
type Option func(*engine)

// WithFactory injects a custom ordered-cursor adapter. The default builds
// in-memory tries.
func WithFactory(f CursorFactory) Option {
	return func(e *engine) { e.factory = f }
}

// Join validates the inputs and returns a pull-based iterator over the natural
// join of relations. Tuple values follow vars (the global variable order),
// which must cover every column exactly once. No work beyond validation and
// trie/index construction happens until Next is called.
func Join(ctx context.Context, vars []string, relations []Relation, opts ...Option) (ResultIterator, error) {
	if len(relations) < 1 || len(relations) > 8 {
		return nil, fmt.Errorf("triejoin: expected 1 to 8 relations, got %d", len(relations))
	}
	if len(vars) == 0 {
		return nil, errors.New("triejoin: global variable order must not be empty")
	}

	globalIndex := make(map[string]int, len(vars))
	for i, v := range vars {
		if v == "" {
			return nil, errors.New("triejoin: global variable order contains an empty variable name")
		}
		if _, dup := globalIndex[v]; dup {
			return nil, fmt.Errorf("triejoin: global variable %q is listed more than once", v)
		}
		globalIndex[v] = i
	}

	seenIDs := make(map[string]bool, len(relations))
	snaps := make([]RelationSnapshot, 0, len(relations))
	hasEmptyRelation := false
	covered := make(map[string]bool)

	for _, rel := range relations {
		if rel.ID == "" {
			return nil, errors.New("triejoin: relation with empty ID")
		}
		if seenIDs[rel.ID] {
			return nil, fmt.Errorf("triejoin: duplicate relation ID %q", rel.ID)
		}
		seenIDs[rel.ID] = true

		colSeen := make(map[string]bool, len(rel.Columns))
		// globalPos[j] is the position of rel.Columns[j] in the global order.
		globalPos := make([]int, 0, len(rel.Columns))
		for _, col := range rel.Columns {
			if col == "" {
				return nil, fmt.Errorf("triejoin: relation %q has an empty column name", rel.ID)
			}
			if colSeen[col] {
				return nil, fmt.Errorf("triejoin: relation %q lists column %q more than once", rel.ID, col)
			}
			colSeen[col] = true
			gi, ok := globalIndex[col]
			if !ok {
				return nil, fmt.Errorf("triejoin: relation %q column %q is absent from global variable order", rel.ID, col)
			}
			covered[col] = true
			globalPos = append(globalPos, gi)
		}

		arity := len(rel.Columns)
		for _, tup := range rel.Tuples {
			if len(tup) != arity {
				return nil, fmt.Errorf("triejoin: relation %q tuple arity %d does not match column count %d",
					rel.ID, len(tup), arity)
			}
		}

		// Zero-arity relation: the set is either {()} (unit) or empty.
		if arity == 0 {
			if len(rel.Tuples) == 0 {
				hasEmptyRelation = true
			}
			snaps = append(snaps, RelationSnapshot{ID: rel.ID, Columns: nil, Tuples: nil})
			continue
		}

		// Bind an immutable snapshot: copy, reorder columns by global order,
		// deduplicate as a set and sort lexicographically.
		orderedTuples := make([][]int64, 0, len(rel.Tuples))
		seen := make(map[string]bool, len(rel.Tuples))
		// Rank each source column among this relation's columns in global order.
		slots := make([]int, arity)
		for src, gi := range globalPos {
			rank := 0
			for _, other := range globalPos {
				if other < gi {
					rank++
				}
			}
			slots[src] = rank
		}
		for _, tup := range rel.Tuples {
			row := make([]int64, arity)
			for src, slot := range slots {
				row[slot] = tup[src]
			}
			key := string(orderedKey(nil, row))
			if seen[key] {
				continue
			}
			seen[key] = true
			orderedTuples = append(orderedTuples, row)
		}
		sort.Slice(orderedTuples, func(i, j int) bool {
			return tupleLess(orderedTuples[i], orderedTuples[j])
		})

		orderedCols := make([]string, arity)
		copy(orderedCols, rel.Columns)
		sort.Slice(orderedCols, func(i, j int) bool {
			return globalIndex[orderedCols[i]] < globalIndex[orderedCols[j]]
		})
		snaps = append(snaps, RelationSnapshot{
			ID:      rel.ID,
			Columns: orderedCols,
			Tuples:  orderedTuples,
		})
		if len(orderedTuples) == 0 {
			hasEmptyRelation = true
		}
	}

	for _, v := range vars {
		if !covered[v] {
			// A variable bound by no relation: its domain is unrestricted and
			// the finite join result is empty.
			hasEmptyRelation = true
		}
	}

	e := &engine{
		ctx:      ctx,
		vars:     append([]string(nil), vars...),
		snaps:    snaps,
		factory:  MemFactory{},
		iterByRI: make(map[int]TrieIterator, len(relations)),
	}
	for _, opt := range opts {
		opt(e)
	}
	if e.factory == nil {
		e.factory = MemFactory{}
	}

	if hasEmptyRelation {
		e.emptyResult = true
	} else if err := e.buildIndexes(); err != nil {
		_ = e.closeAll()
		return nil, err
	}
	return e, nil
}

// ResultIterator streams join tuples in global-variable lexicographic order.
type ResultIterator interface {
	// Next returns the next tuple; ok is false at exhaustion. After Close, or
	// after an earlier error, Next returns an error and never emits a tuple.
	Next() (tuple []int64, ok bool, err error)
	// Counts reports aggregated cursor operation counters.
	Counts() Counts
	// Close cancels the join and closes every cursor; it is idempotent. After
	// Close the iterator can never be read again.
	Close() error
}
