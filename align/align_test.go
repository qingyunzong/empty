package align_test

import (
	"math/rand"
	"reflect"
	"strings"
	"testing"

	"scanalign/align"
)

func script(ops []align.Op) string {
	return strings.TrimSuffix(align.Format(ops), "\n")
}

func TestDiffExamples(t *testing.T) {
	cases := []struct {
		name              string
		expected, scanned []string
		want              string
		wantDistance      int
	}{
		{"both empty", nil, nil, "", 0},
		{"exact match", []string{"a", "b", "c"}, []string{"a", "b", "c"},
			"keep a\nkeep b\nkeep c", 0},
		{"missed scan", []string{"a", "b", "c"}, []string{"a", "c"},
			"keep a\ndel b\nkeep c", 1},
		{"extra scan", []string{"a", "c"}, []string{"a", "b", "c"},
			"keep a\nins b\nkeep c", 1},
		{"all missing", []string{"a", "b"}, nil, "del a\ndel b", 2},
		{"all extra", nil, []string{"a", "b"}, "ins a\nins b", 2},
		{"wrong order", []string{"a", "b"}, []string{"b", "a"},
			"del a\nkeep b\nins a", 2},
		{"duplicates keep positions", []string{"a", "b", "a"}, []string{"a", "a"},
			"keep a\ndel b\nkeep a", 1},
		{"duplicate deletion is positional", []string{"a", "a"}, []string{"a"},
			"del a\nkeep a", 1},
		{"duplicate insertion is positional", []string{"a"}, []string{"a", "a"},
			"ins a\nkeep a", 1},
		{"tie broken lexicographically", []string{"x", "a"}, []string{"a", "x"},
			"del x\nkeep a\nins x", 2},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			ops := align.Diff(tc.expected, tc.scanned)
			if got := script(ops); got != tc.want {
				t.Errorf("Diff(%q, %q) script =\n%s\nwant:\n%s",
					tc.expected, tc.scanned, got, tc.want)
			}
			if d := align.Distance(tc.expected, tc.scanned); d != tc.wantDistance {
				t.Errorf("Distance(%q, %q) = %d, want %d",
					tc.expected, tc.scanned, d, tc.wantDistance)
			}
		})
	}
}

// bruteForce enumerates every edit path between the two sequences and
// returns the minimal cost together with the lexicographically smallest
// minimal script (compared as newline-joined tokens, which orders the same
// as token-by-token comparison since tokens contain no newlines).
func bruteForce(expected, scanned []string) (int, string) {
	bestCost := -1
	bestScript := ""
	var cur []string
	var rec func(i, j, cost int)
	rec = func(i, j, cost int) {
		if bestCost >= 0 && cost > bestCost {
			return
		}
		if i == len(expected) && j == len(scanned) {
			s := strings.Join(cur, "\n")
			if bestCost < 0 || cost < bestCost || s < bestScript {
				bestCost, bestScript = cost, s
			}
			return
		}
		if i < len(expected) && j < len(scanned) && expected[i] == scanned[j] {
			cur = append(cur, "keep "+expected[i])
			rec(i+1, j+1, cost)
			cur = cur[:len(cur)-1]
		}
		if i < len(expected) {
			cur = append(cur, "del "+expected[i])
			rec(i+1, j, cost+1)
			cur = cur[:len(cur)-1]
		}
		if j < len(scanned) {
			cur = append(cur, "ins "+scanned[j])
			rec(i, j+1, cost+1)
			cur = cur[:len(cur)-1]
		}
	}
	rec(0, 0, 0)
	return bestCost, bestScript
}

// allStrings returns every sequence over alphabet with length up to maxLen,
// including the empty sequence.
func allStrings(alphabet []string, maxLen int) [][]string {
	var out [][]string
	var rec func(cur []string)
	rec = func(cur []string) {
		out = append(out, append([]string(nil), cur...))
		if len(cur) == maxLen {
			return
		}
		for _, ch := range alphabet {
			rec(append(cur, ch))
		}
	}
	rec(nil)
	return out
}

// TestBruteForceReference cross-checks Diff and Distance against exhaustive
// enumeration of all edit paths for every pair of short sequences.
func TestBruteForceReference(t *testing.T) {
	for _, cfg := range []struct {
		alphabet []string
		maxLen   int
	}{
		{[]string{"a", "b"}, 5},
		{[]string{"a", "b", "c"}, 4},
	} {
		strs := allStrings(cfg.alphabet, cfg.maxLen)
		for _, expected := range strs {
			for _, scanned := range strs {
				wantCost, wantScript := bruteForce(expected, scanned)
				ops := align.Diff(expected, scanned)
				if got := script(ops); got != wantScript {
					t.Fatalf("Diff(%q, %q) =\n%s\nwant (brute force):\n%s",
						expected, scanned, got, wantScript)
				}
				if d := align.Distance(expected, scanned); d != wantCost {
					t.Fatalf("Distance(%q, %q) = %d, want %d",
						expected, scanned, d, wantCost)
				}
				replayed, err := align.Replay(expected, ops)
				if err != nil {
					t.Fatalf("Replay(%q, Diff(%q, %q)): %v", expected, expected, scanned, err)
				}
				if !reflect.DeepEqual(replayed, scanned) && !(len(replayed) == 0 && len(scanned) == 0) {
					t.Fatalf("Replay(%q, Diff(%q, %q)) = %q, want %q",
						expected, expected, scanned, replayed, scanned)
				}
			}
		}
	}
}

func TestReplayRoundTripRandom(t *testing.T) {
	rng := rand.New(rand.NewSource(1))
	alphabet := []string{"A01", "B02", "C03", "D04"}
	for trial := 0; trial < 500; trial++ {
		expected := make([]string, rng.Intn(12))
		for i := range expected {
			expected[i] = alphabet[rng.Intn(len(alphabet))]
		}
		scanned := make([]string, rng.Intn(12))
		for i := range scanned {
			scanned[i] = alphabet[rng.Intn(len(alphabet))]
		}
		ops := align.Diff(expected, scanned)
		replayed, err := align.Replay(expected, ops)
		if err != nil {
			t.Fatalf("Replay(%q, ops): %v", expected, err)
		}
		if !reflect.DeepEqual(replayed, scanned) && !(len(replayed) == 0 && len(scanned) == 0) {
			t.Fatalf("Replay(%q, Diff) = %q, want %q", expected, replayed, scanned)
		}
		if d1, d2 := align.Distance(expected, scanned), align.Distance(scanned, expected); d1 != d2 {
			t.Fatalf("distance not symmetric: %d != %d for %q vs %q", d1, d2, expected, scanned)
		}
	}
}

func TestFormatParseRoundTrip(t *testing.T) {
	ops := []align.Op{
		{Kind: align.Keep, Item: "a"},
		{Kind: align.Del, Item: "b c"},
		{Kind: align.Ins, Item: "d"},
	}
	parsed, err := align.Parse(align.Format(ops))
	if err != nil {
		t.Fatalf("Parse: %v", err)
	}
	if !reflect.DeepEqual(parsed, ops) {
		t.Fatalf("Parse(Format(ops)) = %+v, want %+v", parsed, ops)
	}
	if _, err := align.Parse("bogus x\n"); err == nil {
		t.Fatal("Parse accepted unknown operation")
	}
	if _, err := align.Parse("del\n"); err == nil {
		t.Fatal("Parse accepted operation without item")
	}
}

func TestReplayErrors(t *testing.T) {
	if _, err := align.Replay([]string{"a"}, []align.Op{{Kind: align.Keep, Item: "b"}}); err == nil {
		t.Fatal("Replay accepted mismatched keep")
	}
	if _, err := align.Replay(nil, []align.Op{{Kind: align.Del, Item: "a"}}); err == nil {
		t.Fatal("Replay accepted delete with no expected items")
	}
	if _, err := align.Replay([]string{"a"}, nil); err == nil {
		t.Fatal("Replay accepted script leaving expected items unconsumed")
	}
	if _, err := align.Replay(nil, []align.Op{{Kind: align.OpKind(42), Item: "a"}}); err == nil {
		t.Fatal("Replay accepted unknown op kind")
	}
}
