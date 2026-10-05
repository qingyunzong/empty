package restore

import (
	"errors"
	"fmt"
	"math/rand"
	"reflect"
	"slices"
	"testing"
)

func TestDedupSameSeqSameContent(t *testing.T) {
	segs := []Segment{
		{Name: "a", Entries: []Entry{{1, "x"}, {2, "y"}, {3, "z"}}},
		{Name: "b", Entries: []Entry{{2, "y"}, {3, "z"}, {4, "w"}}},
	}
	res, err := Restore(0, segs)
	if err != nil {
		t.Fatal(err)
	}
	if res.Gap != nil {
		t.Fatalf("unexpected gap: %v", res.Gap)
	}
	want := []AppliedEntry{
		{Entry{1, "x"}, "a"},
		{Entry{2, "y"}, "a"},
		{Entry{3, "z"}, "a"},
		{Entry{4, "w"}, "b"},
	}
	if !reflect.DeepEqual(res.Applied, want) {
		t.Fatalf("got %+v, want %+v", res.Applied, want)
	}
}

func TestConflictRejected(t *testing.T) {
	segs := []Segment{
		{Name: "a", Entries: []Entry{{1, "x"}, {2, "y"}}},
		{Name: "b", Entries: []Entry{{2, "DIFFERENT"}, {3, "z"}}},
	}
	_, err := Restore(0, segs)
	var ce *ConflictError
	if !errors.As(err, &ce) {
		t.Fatalf("want ConflictError, got %v", err)
	}
	if ce.Seq != 2 || ce.First != "a" || ce.Second != "b" {
		t.Fatalf("bad conflict detail: %+v", ce)
	}
}

func TestGapReportsFirstMissingAndSources(t *testing.T) {
	segs := []Segment{
		{Name: "head", Entries: []Entry{{1, "a"}, {2, "b"}}},
		{Name: "tail1", Entries: []Entry{{5, "e"}, {6, "f"}}},
		{Name: "tail2", Entries: []Entry{{6, "f"}, {7, "g"}}},
	}
	res, err := Restore(0, segs)
	if err != nil {
		t.Fatal(err)
	}
	if res.Gap == nil {
		t.Fatal("want gap, got none")
	}
	if res.Gap.Seq != 3 {
		t.Fatalf("first missing seq = %d, want 3", res.Gap.Seq)
	}
	if !reflect.DeepEqual(res.Gap.Sources, []string{"tail1", "tail2"}) {
		t.Fatalf("gap sources = %v", res.Gap.Sources)
	}
	// Only the continuous prefix before the gap is applied.
	if len(res.Applied) != 2 || res.Applied[1].Seq != 2 {
		t.Fatalf("applied = %+v, want prefix [1 2]", res.Applied)
	}
}

func TestCheckpointPrefixOnly(t *testing.T) {
	segs := []Segment{
		{Name: "a", Entries: []Entry{{1, "old"}, {2, "old"}, {3, "new"}, {4, "new"}}},
		// Conflicting content at or below the checkpoint is ignored.
		{Name: "b", Entries: []Entry{{2, "stale"}, {4, "new"}}},
	}
	res, err := Restore(2, segs)
	if err != nil {
		t.Fatal(err)
	}
	if res.Gap != nil {
		t.Fatalf("unexpected gap: %v", res.Gap)
	}
	if len(res.Applied) != 2 || res.Applied[0].Seq != 3 || res.Applied[1].Seq != 4 {
		t.Fatalf("applied = %+v, want seqs [3 4]", res.Applied)
	}
}

func TestNoEntriesBeyondCheckpoint(t *testing.T) {
	res, err := Restore(5, []Segment{{Name: "a", Entries: []Entry{{4, "x"}, {5, "y"}}}})
	if err != nil {
		t.Fatal(err)
	}
	if len(res.Applied) != 0 || res.Gap != nil {
		t.Fatalf("got %+v, want empty result without gap", res)
	}
}

// makeFullLog builds a continuous log 1..n.
func makeFullLog(n int) []Entry {
	log := make([]Entry, n)
	for i := range log {
		log[i] = Entry{Seq: i + 1, Data: fmt.Sprintf("op-%d", i+1)}
	}
	return log
}

// splitSegments randomly cuts the full log into overlapping contiguous
// segments, then shuffles them. cover=false may leave holes.
func splitSegments(rng *rand.Rand, log []Entry, cover bool) []Segment {
	n := len(log)
	var segs []Segment
	pos := 0
	for pos < n {
		length := 1 + rng.Intn(max(1, n/3))
		end := min(pos+length, n)
		segs = append(segs, Segment{
			Name:    fmt.Sprintf("seg-%d", len(segs)),
			Entries: append([]Entry(nil), log[pos:end]...),
		})
		if cover {
			// Overlap: next segment starts before this one ends.
			pos = end - rng.Intn(max(1, length/2+1))
			if pos >= n {
				break
			}
		} else {
			// Random restart may skip entries, creating gaps.
			pos = rng.Intn(n + 1)
		}
	}
	rng.Shuffle(len(segs), func(i, j int) { segs[i], segs[j] = segs[j], segs[i] })
	return segs
}

func TestRandomSplitShuffleMatchesFullInterpreter(t *testing.T) {
	for seed := int64(0); seed < 200; seed++ {
		rng := rand.New(rand.NewSource(seed))
		n := 1 + rng.Intn(60)
		full := makeFullLog(n)
		checkpoint := rng.Intn(n + 1)
		segs := splitSegments(rng, full, true)

		res, err := Restore(checkpoint, segs)
		if err != nil {
			t.Fatalf("seed %d: %v", seed, err)
		}
		if res.Gap != nil {
			t.Fatalf("seed %d: covering segments produced gap %v", seed, res.Gap)
		}
		want, err := InterpretFull(checkpoint, full)
		if err != nil {
			t.Fatalf("seed %d: interpreter: %v", seed, err)
		}
		got := make([]Entry, len(res.Applied))
		for i, a := range res.Applied {
			got[i] = a.Entry
		}
		if !slices.Equal(got, want) {
			t.Fatalf("seed %d: got %v, want %v", seed, got, want)
		}
		// Every applied entry must come from a segment that really has it.
		bySeq := make(map[int]map[string]bool)
		for _, s := range segs {
			for _, e := range s.Entries {
				if bySeq[e.Seq] == nil {
					bySeq[e.Seq] = make(map[string]bool)
				}
				bySeq[e.Seq][s.Name] = true
			}
		}
		for _, a := range res.Applied {
			if !bySeq[a.Seq][a.Source] {
				t.Fatalf("seed %d: seq %d attributed to %q which lacks it", seed, a.Seq, a.Source)
			}
		}
	}
}

func TestRandomSplitWithHolesReportsGap(t *testing.T) {
	for seed := int64(0); seed < 200; seed++ {
		rng := rand.New(rand.NewSource(seed))
		n := 2 + rng.Intn(60)
		full := makeFullLog(n)
		checkpoint := rng.Intn(n)
		segs := splitSegments(rng, full, false)

		res, err := Restore(checkpoint, segs)
		if err != nil {
			t.Fatalf("seed %d: %v", seed, err)
		}
		// The applied prefix must match the full log exactly.
		want, err := InterpretFull(checkpoint, full)
		if err != nil {
			t.Fatalf("seed %d: interpreter: %v", seed, err)
		}
		if len(res.Applied) > len(want) {
			t.Fatalf("seed %d: applied past the full log", seed)
		}
		for i, a := range res.Applied {
			if a.Entry != want[i] {
				t.Fatalf("seed %d: applied[%d] = %v, want %v", seed, i, a.Entry, want[i])
			}
		}
		if res.Gap != nil {
			// The gap must sit right after the prefix, and the full log
			// must actually continue there.
			if res.Gap.Seq != checkpoint+1+len(res.Applied) {
				t.Fatalf("seed %d: gap seq %d, want %d", seed, res.Gap.Seq, checkpoint+1+len(res.Applied))
			}
			if res.Gap.Seq > n {
				t.Fatalf("seed %d: gap %d beyond full log end %d", seed, res.Gap.Seq, n)
			}
			if len(res.Gap.Sources) == 0 {
				t.Fatalf("seed %d: gap without sources", seed)
			}
		} else {
			// No gap: nothing beyond the prefix may exist in any segment.
			limit := checkpoint + len(res.Applied)
			for _, s := range segs {
				for _, e := range s.Entries {
					if e.Seq > limit {
						t.Fatalf("seed %d: no gap but %s has seq %d beyond %d", seed, s.Name, e.Seq, limit)
					}
				}
			}
		}
	}
}
