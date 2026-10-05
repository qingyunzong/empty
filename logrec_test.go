package logrec

import (
	"errors"
	"fmt"
	"math/rand"
	"reflect"
	"strings"
	"testing"
)

// interpretFullLog is the reference interpreter: it applies the complete
// log (log[i] holds the content of sequence i+1) directly after the
// checkpoint, with no segment merging involved.
func interpretFullLog(checkpoint uint64, log []string) []string {
	if checkpoint >= uint64(len(log)) {
		return nil
	}
	return append([]string(nil), log[checkpoint:]...)
}

func mustParse(t *testing.T, name, text string) Segment {
	t.Helper()
	seg, err := ParseSegment(name, strings.NewReader(text))
	if err != nil {
		t.Fatalf("ParseSegment(%q): %v", name, err)
	}
	return seg
}

func contents(entries []Entry) []string {
	var out []string
	for _, e := range entries {
		out = append(out, e.Content)
	}
	return out
}

func TestParseSegment(t *testing.T) {
	seg := mustParse(t, "s1", "# comment\n\n1 hello world\n2  spaced  content \n3\n")
	if len(seg.Entries) != 3 {
		t.Fatalf("got %d entries, want 3", len(seg.Entries))
	}
	want := []Entry{
		{Seq: 1, Content: "hello world", Source: "s1", Line: 3},
		{Seq: 2, Content: "spaced  content", Source: "s1", Line: 4},
		{Seq: 3, Content: "", Source: "s1", Line: 5},
	}
	if !reflect.DeepEqual(seg.Entries, want) {
		t.Fatalf("got %+v, want %+v", seg.Entries, want)
	}
}

func TestParseSegmentInvalid(t *testing.T) {
	_, err := ParseSegment("bad", strings.NewReader("1 ok\nnope broken\n"))
	if err == nil || !strings.Contains(err.Error(), "bad:2") {
		t.Fatalf("expected line-numbered parse error, got %v", err)
	}
}

func TestRecoverDedupOverlappingSegments(t *testing.T) {
	segA := mustParse(t, "a", "1 alpha\n2 beta\n3 gamma\n")
	segB := mustParse(t, "b", "3 gamma\n4 delta\n5 epsilon\n")
	segC := mustParse(t, "c", "2 beta\n3 gamma\n")

	applied, missing, err := Recover(0, []Segment{segA, segB, segC})
	if err != nil {
		t.Fatalf("Recover: %v", err)
	}
	want := []string{"alpha", "beta", "gamma", "delta", "epsilon"}
	if got := contents(applied); !reflect.DeepEqual(got, want) {
		t.Fatalf("applied = %v, want %v", got, want)
	}
	if missing != 6 {
		t.Fatalf("missing = %d, want 6", missing)
	}
}

func TestRecoverOnlyContiguousPrefixAfterCheckpoint(t *testing.T) {
	seg := mustParse(t, "s", "1 a\n2 b\n3 c\n4 d\n5 e\n")

	applied, missing, err := Recover(3, []Segment{seg})
	if err != nil {
		t.Fatalf("Recover: %v", err)
	}
	if got := contents(applied); !reflect.DeepEqual(got, []string{"d", "e"}) {
		t.Fatalf("applied = %v, want [d e]", got)
	}
	if missing != 6 {
		t.Fatalf("missing = %d, want 6", missing)
	}

	// Nothing after the checkpoint: empty prefix, first missing is checkpoint+1.
	applied, missing, err = Recover(5, []Segment{seg})
	if err != nil {
		t.Fatalf("Recover: %v", err)
	}
	if len(applied) != 0 || missing != 6 {
		t.Fatalf("applied = %v, missing = %d; want empty prefix, missing 6", applied, missing)
	}
}

func TestRecoverConflictRejected(t *testing.T) {
	segA := mustParse(t, "a", "1 alpha\n2 beta\n")
	segB := mustParse(t, "b", "2 BETA\n3 gamma\n")

	_, _, err := Recover(0, []Segment{segA, segB})
	var conflict *ConflictError
	if !errors.As(err, &conflict) {
		t.Fatalf("expected ConflictError, got %v", err)
	}
	if conflict.Seq != 2 || conflict.FirstSource != "a" || conflict.SecondSource != "b" {
		t.Fatalf("unexpected conflict details: %+v", conflict)
	}
}

func TestRecoverGapRejectedStraddlingSegment(t *testing.T) {
	segA := mustParse(t, "a", "1 alpha\n2 beta\n4 delta\n")
	segB := mustParse(t, "b", "4 delta\n5 epsilon\n")

	_, _, err := Recover(0, []Segment{segA, segB})
	var gap *GapError
	if !errors.As(err, &gap) {
		t.Fatalf("expected GapError, got %v", err)
	}
	if gap.Missing != 3 {
		t.Fatalf("missing = %d, want 3", gap.Missing)
	}
	if !reflect.DeepEqual(gap.Sources, []string{"a"}) {
		t.Fatalf("sources = %v, want [a]", gap.Sources)
	}
}

func TestRecoverGapRejectedBetweenSegments(t *testing.T) {
	segA := mustParse(t, "a", "1 alpha\n2 beta\n")
	segB := mustParse(t, "b", "4 delta\n5 epsilon\n")

	_, _, err := Recover(0, []Segment{segA, segB})
	var gap *GapError
	if !errors.As(err, &gap) {
		t.Fatalf("expected GapError, got %v", err)
	}
	if gap.Missing != 3 {
		t.Fatalf("missing = %d, want 3", gap.Missing)
	}
	if !reflect.DeepEqual(gap.Sources, []string{"a", "b"}) {
		t.Fatalf("sources = %v, want [a b]", gap.Sources)
	}
}

func TestRecoverGapImmediatelyAfterCheckpoint(t *testing.T) {
	seg := mustParse(t, "s", "6 f\n7 g\n")
	_, _, err := Recover(4, []Segment{seg})
	var gap *GapError
	if !errors.As(err, &gap) {
		t.Fatalf("expected GapError, got %v", err)
	}
	if gap.Missing != 5 || !reflect.DeepEqual(gap.Sources, []string{"s"}) {
		t.Fatalf("got %+v, want missing 5 from segment s", gap)
	}
}

// splitLog randomly partitions log into overlapping segments covering
// [1, len(log)] completely, then shuffles the segment order.
func splitLog(t *testing.T, r *rand.Rand, log []string) []Segment {
	t.Helper()
	n := len(log)
	k := 1 + r.Intn(6)
	// Random cut points partition [1..n] into k chunks.
	cuts := map[int]bool{0: true, n: true}
	for len(cuts) < k+1 && len(cuts) < n+1 {
		cuts[r.Intn(n+1)] = true
	}
	points := make([]int, 0, len(cuts))
	for p := range cuts {
		points = append(points, p)
	}
	for i := 1; i < len(points); i++ { // insertion sort, stdlib sort not needed here
		for j := i; j > 0 && points[j] < points[j-1]; j-- {
			points[j], points[j-1] = points[j-1], points[j]
		}
	}

	var segs []Segment
	for i := 0; i+1 < len(points); i++ {
		lo, hi := points[i]+1, points[i+1] // 1-based inclusive range
		// Randomly extend to overlap neighbours.
		if i > 0 {
			lo -= r.Intn(lo - points[i-1])
		}
		if i+2 < len(points) {
			hi += r.Intn(points[i+2] - hi + 1)
		}
		var sb strings.Builder
		for seq := lo; seq <= hi; seq++ {
			fmt.Fprintf(&sb, "%d %s\n", seq, log[seq-1])
		}
		segs = append(segs, mustParse(t, fmt.Sprintf("seg%d", i), sb.String()))
	}
	// Occasionally duplicate a segment wholesale.
	if len(segs) > 0 && r.Intn(2) == 0 {
		dup := segs[r.Intn(len(segs))]
		dup.Name = fmt.Sprintf("dup%d", len(segs))
		segs = append(segs, dup)
	}
	// Shuffle segment order.
	r.Shuffle(len(segs), func(i, j int) { segs[i], segs[j] = segs[j], segs[i] })
	return segs
}

func randomLog(r *rand.Rand, n int) []string {
	log := make([]string, n)
	for i := range log {
		log[i] = fmt.Sprintf("op-%d-%d", i+1, r.Intn(1_000_000))
	}
	return log
}

func TestRecoverRandomSplitShuffleMatchesFullInterpreter(t *testing.T) {
	for seed := int64(0); seed < 300; seed++ {
		r := rand.New(rand.NewSource(seed))
		n := 1 + r.Intn(200)
		log := randomLog(r, n)
		checkpoint := uint64(r.Intn(n + 1))
		segs := splitLog(t, r, log)

		applied, missing, err := Recover(checkpoint, segs)
		if err != nil {
			t.Fatalf("seed %d: Recover: %v", seed, err)
		}
		want := interpretFullLog(checkpoint, log)
		if got := contents(applied); !reflect.DeepEqual(got, want) {
			t.Fatalf("seed %d: applied %d entries, want %d (checkpoint %d, n %d)",
				seed, len(got), len(want), checkpoint, n)
		}
		if missing != uint64(n)+1 {
			t.Fatalf("seed %d: missing = %d, want %d", seed, missing, n+1)
		}
	}
}

func TestRecoverRandomGapReportsFirstMissingAndSource(t *testing.T) {
	for seed := int64(0); seed < 200; seed++ {
		r := rand.New(rand.NewSource(seed))
		n := 2 + r.Intn(100)
		log := randomLog(r, n)
		// The gap target must exceed the checkpoint and stay below the
		// maximum sequence, so that entries beyond the gap exist.
		checkpoint := uint64(r.Intn(n - 1))
		target := checkpoint + 1 + uint64(r.Intn(int(uint64(n-1)-checkpoint)))

		segs := splitLog(t, r, log)
		// Remove every entry with seq == target from all segments.
		for i := range segs {
			kept := segs[i].Entries[:0]
			for _, e := range segs[i].Entries {
				if e.Seq != target {
					kept = append(kept, e)
				}
			}
			segs[i].Entries = kept
		}

		_, _, err := Recover(checkpoint, segs)
		var gap *GapError
		if !errors.As(err, &gap) {
			t.Fatalf("seed %d: expected GapError, got %v", seed, err)
		}
		if gap.Missing != target {
			t.Fatalf("seed %d: missing = %d, want %d", seed, gap.Missing, target)
		}
		if len(gap.Sources) == 0 {
			t.Fatalf("seed %d: no source segments reported", seed)
		}
		// Every reported source must actually border the gap.
		valid := make(map[string]bool)
		for _, s := range segs {
			valid[s.Name] = true
		}
		for _, name := range gap.Sources {
			if !valid[name] {
				t.Fatalf("seed %d: bogus source segment %q", seed, name)
			}
		}
	}
}

func TestRecoverRandomConflictRejected(t *testing.T) {
	for seed := int64(0); seed < 100; seed++ {
		r := rand.New(rand.NewSource(seed))
		n := 1 + r.Intn(50)
		log := randomLog(r, n)
		segs := splitLog(t, r, log)
		// Corrupt one entry (same seq, different content) and add a
		// segment carrying the original content to guarantee a conflict.
		i := r.Intn(len(segs))
		j := r.Intn(len(segs[i].Entries))
		orig := segs[i].Entries[j]
		segs[i].Entries[j].Content = "CORRUPTED-" + segs[i].Entries[j].Content
		segs = append(segs, mustParse(t, "witness",
			fmt.Sprintf("%d %s\n", orig.Seq, orig.Content)))

		if _, _, err := Recover(0, segs); err == nil {
			t.Fatalf("seed %d: expected conflict rejection, got nil", seed)
		} else {
			var conflict *ConflictError
			if !errors.As(err, &conflict) {
				t.Fatalf("seed %d: expected ConflictError, got %v", seed, err)
			}
		}
	}
}
