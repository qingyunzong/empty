package logindex

import (
	"bytes"
	"math/rand"
	"slices"
	"testing"
)

// naiveFindAll is the reference matcher: plain byte-by-byte scan that
// reports every (possibly overlapping) occurrence in ascending order.
func naiveFindAll(data, pattern []byte) []int {
	if len(pattern) == 0 {
		return nil
	}
	var out []int
	for i := 0; i+len(pattern) <= len(data); i++ {
		if bytes.Equal(data[i:i+len(pattern)], pattern) {
			out = append(out, i)
		}
	}
	return out
}

func checkAgainstNaive(t *testing.T, snap *Snapshot, data, pattern []byte) {
	t.Helper()
	got := snap.FindAll(pattern)
	want := naiveFindAll(data, pattern)
	if !slices.Equal(got, want) {
		t.Fatalf("FindAll(%q) on %q = %v, want %v", pattern, data, got, want)
	}
	if !slices.IsSorted(got) {
		t.Fatalf("FindAll(%q) result %v not sorted", pattern, got)
	}
}

func TestCrossBoundaryMatch(t *testing.T) {
	s1 := New().Append([]byte("error: disk "))
	if got := s1.FindAll([]byte("disk full")); len(got) != 0 {
		t.Fatalf("old snapshot should not see cross-boundary match, got %v", got)
	}
	s2 := s1.Append([]byte("full on /dev/sda"))
	want := []int{7}
	if got := s2.FindAll([]byte("disk full")); !slices.Equal(got, want) {
		t.Fatalf("new snapshot cross-boundary match = %v, want %v", got, want)
	}
	// Old snapshot still unchanged after the append.
	if got := s1.FindAll([]byte("disk full")); len(got) != 0 {
		t.Fatalf("old snapshot changed after append, got %v", got)
	}
	if s1.Len() != len("error: disk ") {
		t.Fatalf("old snapshot Len = %d, want %d", s1.Len(), len("error: disk "))
	}
}

func TestSnapshotIsolation(t *testing.T) {
	chunks := []string{"abc", "ab", "cab", "abc"}
	snaps := make([]*Snapshot, 0, len(chunks)+1)
	datas := make([][]byte, 0, len(chunks)+1)

	snap := New()
	snaps = append(snaps, snap)
	datas = append(datas, nil)
	var data []byte
	for _, c := range chunks {
		data = append(data, c...)
		snap = snap.Append([]byte(c))
		snaps = append(snaps, snap)
		datas = append(datas, bytes.Clone(data))
	}

	patterns := []string{"a", "ab", "abc", "bcab", "abcabc", "z", ""}
	// Query every snapshot with every pattern before and after further
	// appends happen; results must be identical both times.
	record := make([][][]int, len(snaps))
	for i, s := range snaps {
		for _, p := range patterns {
			record[i] = append(record[i], s.FindAll([]byte(p)))
		}
	}
	// More appends after the queries above.
	extra := snap.Append([]byte("abcabc"))
	for i, s := range snaps {
		for j, p := range patterns {
			got := s.FindAll([]byte(p))
			if !slices.Equal(got, record[i][j]) {
				t.Fatalf("snapshot %d pattern %q changed after later appends: %v -> %v", i, p, record[i][j], got)
			}
			checkAgainstNaive(t, s, datas[i], []byte(p))
		}
	}
	// The newest snapshot sees the full log including cross-boundary matches.
	checkAgainstNaive(t, extra, append(data, "abcabc"...), []byte("abcabc"))
	checkAgainstNaive(t, extra, append(data, "abcabc"...), []byte("cabcab"))
}

func TestOverlappingMatches(t *testing.T) {
	s := New().Append([]byte("aaaa"))
	want := []int{0, 1, 2}
	if got := s.FindAll([]byte("aa")); !slices.Equal(got, want) {
		t.Fatalf("overlapping matches = %v, want %v", got, want)
	}
	s2 := s.Append([]byte("aa"))
	want2 := []int{0, 1, 2, 3, 4}
	if got := s2.FindAll([]byte("aa")); !slices.Equal(got, want2) {
		t.Fatalf("overlapping matches after append = %v, want %v", got, want2)
	}
}

func TestEdgeCases(t *testing.T) {
	empty := New()
	if got := empty.FindAll([]byte("x")); got != nil {
		t.Fatalf("empty snapshot FindAll = %v, want nil", got)
	}
	s := New().Append([]byte("hello"))
	if got := s.FindAll(nil); got != nil {
		t.Fatalf("empty pattern = %v, want nil", got)
	}
	if got := s.FindAll([]byte("hello world, longer than data")); got != nil {
		t.Fatalf("pattern longer than data = %v, want nil", got)
	}
	if got := s.FindAll([]byte("hello")); !slices.Equal(got, []int{0}) {
		t.Fatalf("whole-data match = %v, want [0]", got)
	}
	if got := s.FindAll([]byte("o")); !slices.Equal(got, []int{4}) {
		t.Fatalf("suffix match = %v, want [4]", got)
	}
	// Appending an empty chunk still yields a valid new snapshot.
	s2 := s.Append(nil)
	if s2.Len() != s.Len() {
		t.Fatalf("Len after empty append = %d, want %d", s2.Len(), s.Len())
	}
	checkAgainstNaive(t, s2, []byte("hello"), []byte("ll"))
}

func TestCallerMutationSafety(t *testing.T) {
	chunk := []byte("mutable")
	s := New().Append(chunk)
	for i := range chunk {
		chunk[i] = 'X'
	}
	if got := s.FindAll([]byte("mutable")); !slices.Equal(got, []int{0}) {
		t.Fatalf("snapshot affected by caller mutation, got %v", got)
	}
	if !bytes.Equal(s.Bytes(), []byte("mutable")) {
		t.Fatalf("Bytes = %q, want %q", s.Bytes(), "mutable")
	}
}

// TestRandomizedCrossCheck feeds random chunks through the index and
// verifies every snapshot against the naive matcher, including patterns
// that straddle append boundaries.
func TestRandomizedCrossCheck(t *testing.T) {
	rng := rand.New(rand.NewSource(20261006))
	alphabet := []byte("ab\n ")

	snaps := []*Snapshot{New()}
	var datas [][]byte
	datas = append(datas, nil)

	var data []byte
	for i := 0; i < 40; i++ {
		n := 1 + rng.Intn(12)
		chunk := make([]byte, n)
		for j := range chunk {
			chunk[j] = alphabet[rng.Intn(len(alphabet))]
		}
		data = append(data, chunk...)
		snaps = append(snaps, snaps[len(snaps)-1].Append(chunk))
		datas = append(datas, bytes.Clone(data))
	}

	for i, s := range snaps {
		d := datas[i]
		// Random patterns plus patterns deliberately cut from the log
		// so that some span append boundaries.
		for k := 0; k < 30; k++ {
			pl := 1 + rng.Intn(8)
			pat := make([]byte, pl)
			for j := range pat {
				pat[j] = alphabet[rng.Intn(len(alphabet))]
			}
			checkAgainstNaive(t, s, d, pat)
		}
		for k := 0; k < 30 && len(d) > 0; k++ {
			start := rng.Intn(len(d))
			pl := 1 + rng.Intn(10)
			end := start + pl
			if end > len(d) {
				end = len(d)
			}
			checkAgainstNaive(t, s, d, d[start:end])
		}
	}
}
