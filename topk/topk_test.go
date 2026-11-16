package topk

import (
	"errors"
	"fmt"
	"math/rand/v2"
	"reflect"
	"testing"
)

func keys(entries []Entry) []string {
	out := make([]string, len(entries))
	for i, e := range entries {
		out[i] = e.Key
	}
	return out
}

func TestRankingOrderTieBreaks(t *testing.T) {
	s := NewState()
	recs := []Record{
		{Key: "low-score", Score: 1, EventTime: 1, Weight: 1},
		{Key: "late", Score: 5, EventTime: 20, Weight: 1},
		{Key: "early", Score: 5, EventTime: 10, Weight: 1},
		{Key: "key-b", Score: 5, EventTime: 10, Weight: 1},
		{Key: "key-a", Score: 5, EventTime: 10, Weight: 1},
	}
	for _, r := range recs {
		if err := s.Apply(r); err != nil {
			t.Fatalf("Apply(%+v): %v", r, err)
		}
	}
	// Score desc, then event time asc, then key asc.
	want := []string{"early", "key-a", "key-b", "late", "low-score"}
	if got := keys(s.TopK(5)); !reflect.DeepEqual(got, want) {
		t.Fatalf("TopK order = %v, want %v", got, want)
	}
}

func TestRetractBackfillsMinimalChange(t *testing.T) {
	r := NewRanker(2)
	mustApply := func(rec Record) []Change {
		t.Helper()
		changes, err := r.Apply(rec)
		if err != nil {
			t.Fatalf("Apply(%+v): %v", rec, err)
		}
		return changes
	}
	mustApply(Record{Key: "a", Score: 9, EventTime: 1, Weight: 1})
	mustApply(Record{Key: "b", Score: 8, EventTime: 2, Weight: 1})
	mustApply(Record{Key: "c", Score: 7, EventTime: 3, Weight: 1})
	mustApply(Record{Key: "d", Score: 6, EventTime: 4, Weight: 1})

	// Retracting current member "a" backfills the best candidate "c".
	changes := mustApply(Record{Key: "a", Weight: -1})
	if len(changes) != 2 {
		t.Fatalf("changes = %v, want exactly 2", changes)
	}
	if changes[0].Kind != Left || changes[0].Entry.Key != "a" {
		t.Fatalf("changes[0] = %+v, want Left a", changes[0])
	}
	if changes[1].Kind != Entered || changes[1].Entry.Key != "c" {
		t.Fatalf("changes[1] = %+v, want Entered c", changes[1])
	}
	if got, want := keys(r.Top()), []string{"b", "c"}; !reflect.DeepEqual(got, want) {
		t.Fatalf("Top = %v, want %v", got, want)
	}

	// Retracting a non-member only shifts the candidate set: no change.
	if changes := mustApply(Record{Key: "d", Weight: -1}); len(changes) != 0 {
		t.Fatalf("changes = %v, want none", changes)
	}
}

func TestDisplacementEmitsMinimalChange(t *testing.T) {
	r := NewRanker(2)
	for _, rec := range []Record{
		{Key: "a", Score: 9, EventTime: 1, Weight: 1},
		{Key: "b", Score: 8, EventTime: 2, Weight: 1},
	} {
		if _, err := r.Apply(rec); err != nil {
			t.Fatalf("Apply(%+v): %v", rec, err)
		}
	}
	changes, err := r.Apply(Record{Key: "z", Score: 10, EventTime: 3, Weight: 1})
	if err != nil {
		t.Fatalf("Apply: %v", err)
	}
	if len(changes) != 2 || changes[0].Kind != Left || changes[0].Entry.Key != "b" ||
		changes[1].Kind != Entered || changes[1].Entry.Key != "z" {
		t.Fatalf("changes = %+v, want [Left b, Entered z]", changes)
	}
}

func TestNegativeMultiplicityRejectedStateUnchanged(t *testing.T) {
	r := NewRanker(2)
	if _, err := r.Apply(Record{Key: "a", Score: 9, EventTime: 1, Weight: 2}); err != nil {
		t.Fatalf("Apply add: %v", err)
	}
	if _, err := r.Apply(Record{Key: "b", Score: 8, EventTime: 2, Weight: 1}); err != nil {
		t.Fatalf("Apply add: %v", err)
	}
	before := r.State().Clone()
	beforeTop := r.Top()

	// Retracting 3 of "a" (multiplicity 2) must be rejected.
	_, err := r.Apply(Record{Key: "a", Weight: -3})
	if !errors.Is(err, ErrNegativeMultiplicity) {
		t.Fatalf("err = %v, want ErrNegativeMultiplicity", err)
	}
	// Retracting a key that was never added must be rejected.
	if _, err = r.Apply(Record{Key: "ghost", Weight: -1}); !errors.Is(err, ErrNegativeMultiplicity) {
		t.Fatalf("err = %v, want ErrNegativeMultiplicity", err)
	}

	if got := r.State(); !reflect.DeepEqual(got.Entries(), before.Entries()) {
		t.Fatalf("state changed after rejection: got %v, want %v", got.Entries(), before.Entries())
	}
	if got := r.Top(); !reflect.DeepEqual(got, beforeTop) {
		t.Fatalf("top changed after rejection: got %v, want %v", got, beforeTop)
	}
	if m := r.State().Multiplicity("a"); m != 2 {
		t.Fatalf("multiplicity(a) = %d, want 2", m)
	}
}

func TestPartialRetractKeepsMember(t *testing.T) {
	r := NewRanker(1)
	if _, err := r.Apply(Record{Key: "a", Score: 9, EventTime: 1, Weight: 2}); err != nil {
		t.Fatalf("Apply add: %v", err)
	}
	changes, err := r.Apply(Record{Key: "a", Weight: -1})
	if err != nil {
		t.Fatalf("Apply retract: %v", err)
	}
	if len(changes) != 0 {
		t.Fatalf("changes = %v, want none: member survives partial retract", changes)
	}
	if got := r.Top(); len(got) != 1 || got[0].Key != "a" || got[0].Multiplicity != 1 {
		t.Fatalf("Top = %+v, want [a x1]", got)
	}
}

func TestAttributeUpdateReported(t *testing.T) {
	r := NewRanker(1)
	if _, err := r.Apply(Record{Key: "a", Score: 5, EventTime: 1, Weight: 1}); err != nil {
		t.Fatalf("Apply: %v", err)
	}
	changes, err := r.Apply(Record{Key: "a", Score: 7, EventTime: 2, Weight: 1})
	if err != nil {
		t.Fatalf("Apply: %v", err)
	}
	if len(changes) != 1 || changes[0].Kind != Updated || changes[0].Entry.Attr.Score != 7 {
		t.Fatalf("changes = %+v, want [Updated a score=7]", changes)
	}
}

// TestShardMergeEquivalence splits a random retracting stream across
// shards by key and verifies the merged state matches the full-stream
// computation exactly, both for the multiset and the resulting Top-K.
func TestShardMergeEquivalence(t *testing.T) {
	rng := rand.New(rand.NewPCG(112, 252))
	const (
		numKeys   = 30
		numEvents = 3000
		numShards = 3
		k         = 7
	)

	full := NewState()
	shards := make([]*State, numShards)
	for i := range shards {
		shards[i] = NewState()
	}

	for i := 0; i < numEvents; i++ {
		keyNum := rng.IntN(numKeys)
		rec := Record{
			Key:       fmt.Sprintf("key-%02d", keyNum),
			Score:     float64(rng.IntN(50)),
			EventTime: int64(rng.IntN(500)),
			Weight:    int64(rng.IntN(4)) + 1,
		}
		if rng.IntN(2) == 0 {
			rec.Weight = -rec.Weight
		}
		fullErr := full.Apply(rec)
		shardErr := shards[keyNum%numShards].Apply(rec)
		if (fullErr == nil) != (shardErr == nil) {
			t.Fatalf("event %d (%+v): full err %v, shard err %v", i, rec, fullErr, shardErr)
		}
	}

	merged := NewState()
	for _, sh := range shards {
		merged.Merge(sh)
	}
	if got, want := merged.Entries(), full.Entries(); !reflect.DeepEqual(got, want) {
		t.Fatalf("merged entries differ from full computation:\n got %v\nwant %v", got, want)
	}
	if got, want := merged.TopK(k), full.TopK(k); !reflect.DeepEqual(got, want) {
		t.Fatalf("merged TopK differs from full computation:\n got %v\nwant %v", got, want)
	}
}
