package dataeng

import (
	"errors"
	"fmt"
	"math/rand"
	"reflect"
	"sort"
	"testing"
)

var errBoom = errors.New("boom")

// refRanker is the reference implementation: it keeps no incremental state
// and fully re-sorts every touched group on every batch.
type refRanker struct {
	k      int
	index  map[string]record
	boards map[string][]Entry
}

func newRefRanker(k int) *refRanker {
	return &refRanker{
		k:      k,
		index:  make(map[string]record),
		boards: make(map[string][]Entry),
	}
}

func (rr *refRanker) apply(batch []Op, emit func([]Change) error) error {
	idx := make(map[string]record, len(rr.index))
	for id, rec := range rr.index {
		idx[id] = rec
	}
	touched := make(map[string]struct{})
	for i, op := range batch {
		switch op.Kind {
		case OpUpsert:
			if op.ID == "" || op.Group == "" {
				return fmt.Errorf("op %d: %w", i, ErrInvalidOp)
			}
			if cur, ok := idx[op.ID]; ok {
				touched[cur.group] = struct{}{}
			}
			idx[op.ID] = record{group: op.Group, score: op.Score}
			touched[op.Group] = struct{}{}
		case OpDelete:
			if op.ID == "" {
				return fmt.Errorf("op %d: %w", i, ErrInvalidOp)
			}
			cur, ok := idx[op.ID]
			if !ok {
				return fmt.Errorf("op %d: %w", i, ErrNotFound)
			}
			delete(idx, op.ID)
			touched[cur.group] = struct{}{}
		default:
			return fmt.Errorf("op %d: %w", i, ErrInvalidOp)
		}
	}

	names := make([]string, 0, len(touched))
	for name := range touched {
		names = append(names, name)
	}
	sort.Strings(names)

	var changes []Change
	boards := make(map[string][]Entry, len(names))
	counts := make(map[string]int, len(names))
	for _, name := range names {
		var members []member
		for id, rec := range idx {
			if rec.group == name {
				members = append(members, member{id: id, score: rec.score})
			}
		}
		sort.Slice(members, func(i, j int) bool { return lessMember(members[i], members[j]) })
		counts[name] = len(members)
		n := len(members)
		if n > rr.k {
			n = rr.k
		}
		board := make([]Entry, n)
		for i := 0; i < n; i++ {
			board[i] = Entry{Rank: i + 1, ID: members[i].id, Score: members[i].score}
		}
		boards[name] = board
		changes = append(changes, diffBoards(name, rr.boards[name], board)...)
	}

	if len(changes) > 0 && emit != nil {
		if err := emit(changes); err != nil {
			return err
		}
	}

	rr.index = idx
	for _, name := range names {
		if counts[name] == 0 {
			delete(rr.boards, name)
		} else {
			rr.boards[name] = boards[name]
		}
	}
	return nil
}

func randomBatch(rng *rand.Rand, ids, groups []string) []Op {
	n := 1 + rng.Intn(8)
	ops := make([]Op, 0, n+2)
	for i := 0; i < n; i++ {
		if rng.Intn(5) == 0 {
			ops = append(ops, Delete(ids[rng.Intn(len(ids))]))
		} else {
			ops = append(ops, Upsert(
				ids[rng.Intn(len(ids))],
				groups[rng.Intn(len(groups))],
				int64(rng.Intn(8)), // small score range forces ties
			))
		}
	}
	// Frequently delete and re-insert the same ID within one batch.
	if rng.Intn(3) == 0 {
		id := ids[rng.Intn(len(ids))]
		ops = append(ops,
			Delete(id),
			Upsert(id, groups[rng.Intn(len(groups))], int64(rng.Intn(8))),
		)
	}
	return ops
}

func captureOrFail(dst *[]Change, fail bool) func([]Change) error {
	return func(ch []Change) error {
		*dst = append([]Change(nil), ch...)
		if fail {
			return errBoom
		}
		return nil
	}
}

func checkState(t *testing.T, main *Ranker, ref *refRanker, ids, groups []string) {
	t.Helper()
	for _, g := range groups {
		got, want := main.Top(g), ref.boards[g]
		if !reflect.DeepEqual(got, want) {
			t.Fatalf("group %q board mismatch:\n got %+v\nwant %+v", g, got, want)
		}
	}
	for _, id := range ids {
		g, s, ok := main.Get(id)
		rec, rok := ref.index[id]
		if ok != rok || (ok && (g != rec.group || s != rec.score)) {
			t.Fatalf("Get(%q) = %q, %d, %v; ref = %+v, %v", id, g, s, ok, rec, rok)
		}
	}
	if main.Len() != len(ref.index) {
		t.Fatalf("Len = %d, ref has %d", main.Len(), len(ref.index))
	}
}

// TestAgainstReference cross-checks the incremental Ranker against the
// full-sort reference over randomized batches, covering tie eviction, group
// migration, delete-then-reinsert within a batch, and rollback after both
// invalid ops and emit failures.
func TestAgainstReference(t *testing.T) {
	rng := rand.New(rand.NewSource(20261112))
	ids := make([]string, 16)
	for i := range ids {
		ids[i] = fmt.Sprintf("id-%02d", i)
	}
	groups := []string{"alpha", "beta", "gamma", "delta", "epsilon"}

	for trial := 0; trial < 40; trial++ {
		k := 1 + rng.Intn(6)
		main := New(k)
		ref := newRefRanker(k)

		for b := 0; b < 60; b++ {
			ops := randomBatch(rng, ids, groups)
			failEmit := rng.Intn(4) == 0

			var mainCh, refCh []Change
			mainErr := main.Apply(ops, captureOrFail(&mainCh, failEmit))
			refErr := ref.apply(ops, captureOrFail(&refCh, failEmit))

			if (mainErr != nil) != (refErr != nil) {
				t.Fatalf("trial %d batch %d: error mismatch: main=%v ref=%v ops=%v",
					trial, b, mainErr, refErr, ops)
			}
			if !reflect.DeepEqual(mainCh, refCh) {
				t.Fatalf("trial %d batch %d: changes mismatch:\nmain %+v\n ref %+v",
					trial, b, mainCh, refCh)
			}

			// Emit failed after a valid batch: state must be uncommitted and
			// the same batch must be retryable, emitting identical changes.
			if failEmit && mainErr != nil && mainCh != nil {
				var mainRetry, refRetry []Change
				if err := main.Apply(ops, captureOrFail(&mainRetry, false)); err != nil {
					t.Fatalf("trial %d batch %d: main retry: %v", trial, b, err)
				}
				if err := ref.apply(ops, captureOrFail(&refRetry, false)); err != nil {
					t.Fatalf("trial %d batch %d: ref retry: %v", trial, b, err)
				}
				if !reflect.DeepEqual(mainRetry, mainCh) {
					t.Fatalf("trial %d batch %d: retry emitted different changes:\nfirst %+v\nretry %+v",
						trial, b, mainCh, mainRetry)
				}
				if !reflect.DeepEqual(mainRetry, refRetry) {
					t.Fatalf("trial %d batch %d: retry mismatch vs ref:\nmain %+v\n ref %+v",
						trial, b, mainRetry, refRetry)
				}
			}

			checkState(t, main, ref, ids, groups)
		}
	}
}
