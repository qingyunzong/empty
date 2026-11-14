package scd2

import "fmt"

// ChangeKind classifies a changeset entry.
type ChangeKind int

const (
	// ChangeAdd inserts a new interval row.
	ChangeAdd ChangeKind = iota
	// ChangeUpdate rewrites an existing interval row in place.
	ChangeUpdate
	// ChangeRemove deletes an existing interval row.
	ChangeRemove
)

func (k ChangeKind) String() string {
	switch k {
	case ChangeAdd:
		return "ADD"
	case ChangeUpdate:
		return "UPDATE"
	case ChangeRemove:
		return "REMOVE"
	}
	return "?"
}

// Change is one minimal mutation. Old is set for updates and removes, New
// for adds and updates.
type Change[A any] struct {
	Kind ChangeKind
	Key  string
	Old  Interval[A]
	New  Interval[A]
}

func (c Change[A]) String() string {
	switch c.Kind {
	case ChangeAdd:
		return fmt.Sprintf("ADD    %s", c.New)
	case ChangeUpdate:
		return fmt.Sprintf("UPDATE %s -> %s", c.Old, c.New)
	default:
		return fmt.Sprintf("REMOVE %s", c.Old)
	}
}

// Changeset is the minimal list of mutations produced by one Apply call.
// Removes and updates are emitted before adds so that the unique-current
// invariant is never violated mid-application.
type Changeset[A any] []Change[A]

// Empty reports whether the changeset contains no mutations.
func (cs Changeset[A]) Empty() bool { return len(cs) == 0 }

// Counts returns the number of adds, updates and removes.
func (cs Changeset[A]) Counts() (adds, updates, removes int) {
	for _, c := range cs {
		switch c.Kind {
		case ChangeAdd:
			adds++
		case ChangeUpdate:
			updates++
		case ChangeRemove:
			removes++
		}
	}
	return
}

// diffIntervals computes the minimal changeset between two interval lists
// for one key: an LCS of unchanged intervals, with unmatched old/new
// intervals between anchors paired in order as updates and the remainder
// as removes/adds.
func diffIntervals[A any](key string, oldList, newList []Interval[A], eq func(a, b A) bool) Changeset[A] {
	same := func(x, y Interval[A]) bool {
		return x.From.Equal(y.From) && x.To.Equal(y.To) && eq(x.Attrs, y.Attrs)
	}

	n, m := len(oldList), len(newList)
	dp := make([][]int, n+1)
	for i := range dp {
		dp[i] = make([]int, m+1)
	}
	for i := n - 1; i >= 0; i-- {
		for j := m - 1; j >= 0; j-- {
			switch {
			case same(oldList[i], newList[j]):
				dp[i][j] = dp[i+1][j+1] + 1
			case dp[i+1][j] >= dp[i][j+1]:
				dp[i][j] = dp[i+1][j]
			default:
				dp[i][j] = dp[i][j+1]
			}
		}
	}

	stamp := func(iv Interval[A]) Interval[A] { iv.Key = key; return iv }
	var updates, removes, adds []Change[A]

	// Extract the LCS anchor pairs from the DP table.
	type anchor struct{ i, j int }
	anchors := []anchor{{-1, -1}}
	for i, j := 0, 0; i < n && j < m; {
		switch {
		case same(oldList[i], newList[j]) && dp[i][j] == dp[i+1][j+1]+1:
			anchors = append(anchors, anchor{i, j})
			i++
			j++
		case dp[i+1][j] >= dp[i][j+1]:
			i++
		default:
			j++
		}
	}
	anchors = append(anchors, anchor{n, m})

	// Pair unmatched intervals between consecutive anchors in order.
	for a := 1; a < len(anchors); a++ {
		olds := oldList[anchors[a-1].i+1 : anchors[a].i]
		news := newList[anchors[a-1].j+1 : anchors[a].j]
		k := 0
		for ; k < len(olds) && k < len(news); k++ {
			updates = append(updates, Change[A]{Kind: ChangeUpdate, Key: key, Old: stamp(olds[k]), New: stamp(news[k])})
		}
		for ; k < len(olds); k++ {
			removes = append(removes, Change[A]{Kind: ChangeRemove, Key: key, Old: stamp(olds[k])})
		}
		for ; k < len(news); k++ {
			adds = append(adds, Change[A]{Kind: ChangeAdd, Key: key, New: stamp(news[k])})
		}
	}

	out := make(Changeset[A], 0, len(removes)+len(updates)+len(adds))
	out = append(out, removes...)
	out = append(out, updates...)
	out = append(out, adds...)
	return out
}
