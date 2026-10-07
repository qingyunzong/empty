package corrector

import (
	"fmt"
	"math/rand"
	"slices"
	"testing"
)

func TestDiffTable(t *testing.T) {
	cases := []struct {
		name              string
		expected, scanned []string
		want              Script
	}{
		{
			name:     "both empty",
			expected: nil, scanned: nil,
			want: nil,
		},
		{
			name:     "identical sequences",
			expected: []string{"a", "b", "c"}, scanned: []string{"a", "b", "c"},
			want: nil,
		},
		{
			name:     "all missed scans",
			expected: []string{"a", "b"}, scanned: nil,
			want: Script{
				{Kind: Insert, Index: 0, Barcode: "a"},
				{Kind: Insert, Index: 1, Barcode: "b"},
			},
		},
		{
			name:     "all extra scans",
			expected: nil, scanned: []string{"x", "y"},
			want: Script{
				{Kind: Delete, Index: 0, Barcode: "x"},
				{Kind: Delete, Index: 0, Barcode: "y"},
			},
		},
		{
			name:     "one missed scan in the middle",
			expected: []string{"a", "b", "c"}, scanned: []string{"a", "c"},
			want: Script{
				{Kind: Insert, Index: 1, Barcode: "b"},
			},
		},
		{
			name:     "one duplicate scan",
			expected: []string{"a"}, scanned: []string{"a", "a"},
			want: Script{
				{Kind: Delete, Index: 0, Barcode: "a"},
			},
		},
		{
			// Inserting before or after the existing "a" costs the
			// same; the smaller index wins.
			name:     "duplicate barcodes keep positions",
			expected: []string{"a", "a"}, scanned: []string{"a"},
			want: Script{
				{Kind: Insert, Index: 0, Barcode: "a"},
			},
		},
		{
			name:     "out of order tail",
			expected: []string{"a", "b", "c"}, scanned: []string{"c", "a", "b"},
			want: Script{
				{Kind: Delete, Index: 0, Barcode: "c"},
				{Kind: Insert, Index: 2, Barcode: "c"},
			},
		},
		{
			// Two minimum-cost scripts exist: delete the first "a" or the
			// second one. The lexicographically smaller index wins.
			name:     "tie broken by lexicographic order",
			expected: []string{"a", "b"}, scanned: []string{"a", "a", "b"},
			want: Script{
				{Kind: Delete, Index: 0, Barcode: "a"},
			},
		},
		{
			// Delete ties with insert on cost; Delete < Insert wins.
			name:     "delete beats insert on tie",
			expected: []string{"b"}, scanned: []string{"a"},
			want: Script{
				{Kind: Delete, Index: 0, Barcode: "a"},
				{Kind: Insert, Index: 0, Barcode: "b"},
			},
		},
		{
			name:     "mixed duplicates misses and disorder",
			expected: []string{"a", "b", "b", "c"}, scanned: []string{"b", "a", "b", "b"},
			want: Script{
				{Kind: Delete, Index: 0, Barcode: "b"},
				{Kind: Insert, Index: 3, Barcode: "c"},
			},
		},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			got := Diff(tc.expected, tc.scanned)
			if !slices.Equal(got, tc.want) {
				t.Fatalf("Diff(%q, %q) = %v, want %v", tc.expected, tc.scanned, got, tc.want)
			}
			assertReplay(t, tc.expected, tc.scanned, got)
		})
	}
}

func assertReplay(t *testing.T, expected, scanned []string, script Script) {
	t.Helper()
	got, err := script.Apply(scanned)
	if err != nil {
		t.Fatalf("Apply(%v): %v", script, err)
	}
	if !slices.Equal(got, expected) {
		t.Fatalf("Apply(%v, %q) = %q, want %q", script, scanned, got, expected)
	}
}

// bruteForce is an independent reference implementation: it searches
// every edit path by iterative deepening on the cost and returns the
// lexicographically smallest script among all minimum-cost ones. It is
// exponential and only usable for short sequences.
func bruteForce(expected, scanned []string) Script {
	for depth := 0; depth <= len(expected)+len(scanned); depth++ {
		if best, found := scriptsAtCost(expected, scanned, depth); found {
			return best
		}
	}
	panic("unreachable: delete-all plus insert-all always works")
}

func scriptsAtCost(expected, scanned []string, depth int) (Script, bool) {
	var best Script
	var found bool
	var walk func(i, j, remaining int, ops []Op)
	walk = func(i, j, remaining int, ops []Op) {
		if i == len(scanned) && j == len(expected) {
			if remaining == 0 && (!found || Compare(ops, best) < 0) {
				best = slices.Clone(ops)
				found = true
			}
			return
		}
		if i < len(scanned) && j < len(expected) && scanned[i] == expected[j] {
			walk(i+1, j+1, remaining, ops)
		}
		if remaining == 0 {
			return
		}
		if i < len(scanned) {
			walk(i+1, j, remaining-1, append(slices.Clone(ops), Op{Kind: Delete, Index: j, Barcode: scanned[i]}))
		}
		if j < len(expected) {
			walk(i, j+1, remaining-1, append(slices.Clone(ops), Op{Kind: Insert, Index: j, Barcode: expected[j]}))
		}
	}
	walk(0, 0, depth, nil)
	return best, found
}

// TestShortStringsAgainstBruteForce enumerates every pair of sequences
// over a small alphabet up to a bounded length and checks Diff against
// the exhaustive reference, including replay of the emitted script.
func TestShortStringsAgainstBruteForce(t *testing.T) {
	alphabet := []string{"a", "b", "c"}
	const maxLen = 4
	var seqs [][]string
	seqs = append(seqs, nil)
	for length := 1; length <= maxLen; length++ {
		var next [][]string
		for _, seq := range seqs {
			if len(seq) != length-1 {
				continue
			}
			for _, sym := range alphabet {
				next = append(next, append(slices.Clone(seq), sym))
			}
		}
		seqs = append(seqs, next...)
	}
	for _, expected := range seqs {
		for _, scanned := range seqs {
			name := fmt.Sprintf("expected=%q/scanned=%q", expected, scanned)
			t.Run(name, func(t *testing.T) {
				got := Diff(expected, scanned)
				want := bruteForce(expected, scanned)
				if !slices.Equal(got, want) {
					t.Fatalf("Diff = %v, brute force = %v", got, want)
				}
				assertReplay(t, expected, scanned, got)
			})
		}
	}
}

// TestRandomAgainstBruteForce adds randomized coverage with a larger
// alphabet and slightly longer sequences.
func TestRandomAgainstBruteForce(t *testing.T) {
	rng := rand.New(rand.NewSource(1))
	alphabet := []string{"a", "b", "c", "d"}
	for trial := 0; trial < 300; trial++ {
		expected := randomSeq(rng, alphabet, 5)
		scanned := randomSeq(rng, alphabet, 5)
		got := Diff(expected, scanned)
		want := bruteForce(expected, scanned)
		if !slices.Equal(got, want) {
			t.Fatalf("Diff(%q, %q) = %v, brute force = %v", expected, scanned, got, want)
		}
		assertReplay(t, expected, scanned, got)
	}
}

func randomSeq(rng *rand.Rand, alphabet []string, maxLen int) []string {
	length := rng.Intn(maxLen + 1)
	seq := make([]string, length)
	for i := range seq {
		seq[i] = alphabet[rng.Intn(len(alphabet))]
	}
	return seq
}

func TestDistance(t *testing.T) {
	if got := Distance([]string{"a", "b", "c"}, []string{"c", "a", "b"}); got != 2 {
		t.Fatalf("Distance = %d, want 2", got)
	}
	if got := Distance(nil, nil); got != 0 {
		t.Fatalf("Distance = %d, want 0", got)
	}
}

func TestScriptStringRoundTrip(t *testing.T) {
	scripts := []Script{
		nil,
		{
			{Kind: Delete, Index: 0, Barcode: "x"},
			{Kind: Insert, Index: 0, Barcode: "y"},
		},
		{
			{Kind: Insert, Index: 3, Barcode: "with space and \"quote\""},
			{Kind: Delete, Index: 3, Barcode: "tab\tand\nnewline"},
		},
	}
	for _, script := range scripts {
		parsed, err := ParseScript(script.String())
		if err != nil {
			t.Fatalf("ParseScript(%q): %v", script.String(), err)
		}
		if !slices.Equal(parsed, script) {
			t.Fatalf("round trip = %v, want %v", parsed, script)
		}
	}
}

func TestParseScriptErrors(t *testing.T) {
	for _, text := range []string{
		"X 0 \"a\"",
		"D notanumber \"a\"",
		"D 0 unquoted",
		"D 0",
	} {
		if _, err := ParseScript(text); err == nil {
			t.Fatalf("ParseScript(%q) succeeded, want error", text)
		}
	}
}

func TestApplyErrors(t *testing.T) {
	if _, err := (Script{{Kind: Delete, Index: 5, Barcode: "a"}}).Apply([]string{"a"}); err == nil {
		t.Fatal("delete out of range: want error")
	}
	if _, err := (Script{{Kind: Delete, Index: 0, Barcode: "b"}}).Apply([]string{"a"}); err == nil {
		t.Fatal("delete barcode mismatch: want error")
	}
	if _, err := (Script{{Kind: Insert, Index: 2, Barcode: "a"}}).Apply([]string{"a"}); err == nil {
		t.Fatal("insert out of range: want error")
	}
	if _, err := (Script{{Kind: OpKind(9), Index: 0}}).Apply(nil); err == nil {
		t.Fatal("unknown op kind: want error")
	}
}

func TestCompare(t *testing.T) {
	a := Script{{Kind: Delete, Index: 0, Barcode: "a"}}
	b := Script{{Kind: Insert, Index: 0, Barcode: "a"}}
	if Compare(a, b) >= 0 {
		t.Fatal("delete must sort before insert")
	}
	if Compare(a, a) != 0 {
		t.Fatal("equal scripts must compare equal")
	}
	short := Script{{Kind: Delete, Index: 0, Barcode: "a"}}
	long := Script{{Kind: Delete, Index: 0, Barcode: "a"}, {Kind: Insert, Index: 1, Barcode: "b"}}
	if Compare(short, long) >= 0 {
		t.Fatal("prefix script must be smaller")
	}
}
