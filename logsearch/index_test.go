package logsearch

import (
	"math/rand"
	"reflect"
	"testing"
)

// naiveSearch finds every occurrence of pattern in data by plain
// byte-by-byte comparison, reporting all overlapping offsets in
// ascending order. It is the reference implementation for tests.
func naiveSearch(data, pattern []byte) []int {
	if len(pattern) == 0 {
		return nil
	}
	var hits []int
	for off := 0; off+len(pattern) <= len(data); off++ {
		match := true
		for k := 0; k < len(pattern); k++ {
			if data[off+k] != pattern[k] {
				match = false
				break
			}
		}
		if match {
			hits = append(hits, off)
		}
	}
	return hits
}

func TestSearchSortedAndOverlapping(t *testing.T) {
	idx := New().Append([]byte("aaaa"))
	want := []int{0, 1, 2}
	if got := idx.Search([]byte("aa")); !reflect.DeepEqual(got, want) {
		t.Fatalf("Search(aa) over aaaa = %v, want %v", got, want)
	}
}

func TestCrossBoundaryMatch(t *testing.T) {
	snap1 := New().Append([]byte("ab"))
	snap2 := snap1.Append([]byte("cd"))

	if got := snap2.Search([]byte("bc")); !reflect.DeepEqual(got, []int{1}) {
		t.Fatalf("new snapshot Search(bc) = %v, want [1]", got)
	}
	if got := snap1.Search([]byte("bc")); len(got) != 0 {
		t.Fatalf("old snapshot Search(bc) = %v, want no hits", got)
	}
}

func TestSnapshotIsolation(t *testing.T) {
	snap1 := New().Append([]byte("hello "))
	before := snap1.Search([]byte("lo"))

	snap2 := snap1.Append([]byte("log log"))
	// Query the old snapshot again after the append happened.
	after := snap1.Search([]byte("lo"))

	if !reflect.DeepEqual(before, after) {
		t.Fatalf("old snapshot results changed after append: before %v, after %v", before, after)
	}
	if want := []int{3}; !reflect.DeepEqual(after, want) {
		t.Fatalf("old snapshot Search(lo) = %v, want %v", after, want)
	}
	if want := []int{3, 6, 10}; !reflect.DeepEqual(snap2.Search([]byte("lo")), want) {
		t.Fatalf("new snapshot Search(lo) = %v, want %v", snap2.Search([]byte("lo")), want)
	}
	if snap1.Len() != len("hello ") || snap2.Len() != len("hello log log") {
		t.Fatalf("snapshot lengths wrong: snap1=%d snap2=%d", snap1.Len(), snap2.Len())
	}
}

func TestEmptyPattern(t *testing.T) {
	idx := New().Append([]byte("abc"))
	if got := idx.Search(nil); got != nil {
		t.Fatalf("Search(nil) = %v, want nil", got)
	}
	if got := idx.Search([]byte{}); got != nil {
		t.Fatalf("Search(empty) = %v, want nil", got)
	}
}

// TestAgainstNaive builds an index through random appends over a tiny
// alphabet (to force overlaps and cross-boundary matches), then checks
// every snapshot against the naive matcher with random patterns, both
// before and after further appends.
func TestAgainstNaive(t *testing.T) {
	rng := rand.New(rand.NewSource(1))
	const alphabet = "ab"

	var snaps []*Index
	var datas [][]byte
	idx := New()
	var data []byte
	snaps = append(snaps, idx)
	datas = append(datas, append([]byte(nil), data...))

	for i := 0; i < 40; i++ {
		n := rng.Intn(8)
		chunk := make([]byte, n)
		for j := range chunk {
			chunk[j] = alphabet[rng.Intn(len(alphabet))]
		}
		idx = idx.Append(chunk)
		data = append(data, chunk...)
		snaps = append(snaps, idx)
		datas = append(datas, append([]byte(nil), data...))
	}

	check := func(snap *Index, wantData []byte) {
		t.Helper()
		if snap.Len() != len(wantData) {
			t.Fatalf("snapshot Len = %d, want %d", snap.Len(), len(wantData))
		}
		for p := 0; p < 50; p++ {
			m := rng.Intn(6)
			pat := make([]byte, m)
			for j := range pat {
				pat[j] = alphabet[rng.Intn(len(alphabet))]
			}
			got := snap.Search(pat)
			want := naiveSearch(wantData, pat)
			if len(got) == 0 && len(want) == 0 {
				continue
			}
			if !reflect.DeepEqual(got, want) {
				t.Fatalf("Search(%q) over %q = %v, want %v", pat, wantData, got, want)
			}
		}
	}

	// Every historical snapshot must still answer as if later appends
	// never happened.
	for i, snap := range snaps {
		check(snap, datas[i])
	}
}
