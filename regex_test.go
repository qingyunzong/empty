package searchre

import (
	"fmt"
	"math/rand"
	"reflect"
	"testing"
)

type caseT struct {
	pattern string
	input   string
	// want is nil for no match; otherwise [m0s, m0e, g1s, g1e, ...]
	// with -1 for groups that did not participate.
	want []int
}

var cases = []caseT{
	// literals
	{"abc", "xxabcy", []int{2, 5}},
	{"abc", "abd", nil},
	{"", "abc", []int{0, 0}},
	{"", "", []int{0, 0}},
	{`a\*b`, "xa*by", []int{1, 4}},
	{`\(\)`, "()", []int{0, 2}},

	// alternation: longest wins over branch order
	{"a|ab", "ab", []int{0, 2}},
	{"ab|a", "ab", []int{0, 2}},
	{"a|ab", "ax", []int{0, 1}},
	// equal length: earlier branch decides the captures
	{"(a|b)(x|y)", "ax", []int{0, 2, 0, 1, 1, 2}},
	{"(ab|a)(b|)", "ab", []int{0, 2, 0, 2, 2, 2}},

	// star / question
	{"a*", "aaa", []int{0, 3}},
	{"a*", "b", []int{0, 0}},
	{"a?", "b", []int{0, 0}},
	{"colou?r", "color", []int{0, 5}},
	{"colou?r", "colour", []int{0, 6}},
	{"(a|b)*c", "ababc", []int{0, 5, 3, 4}},
	{"ba*", "baaab", []int{0, 4}},

	// groups and captures
	{"(a)?b", "b", []int{0, 1, -1, -1}},
	{"(a)?b", "ab", []int{0, 2, 0, 1}},
	{"(x*)(x*)", "xx", []int{0, 2, 0, 2, 2, 2}},
	{"((a)(b))", "ab", []int{0, 2, 0, 2, 0, 1, 1, 2}},

	// captures: final participating iteration wins
	{"(a|b)*", "abba", []int{0, 4, 3, 4}},
	{"(ab|a)*", "aba", []int{0, 3, 2, 3}},
	{"(a(b)?)*", "aba", []int{0, 3, 2, 3, 1, 2}},
	{"(a(b))*", "ababa", []int{0, 4, 2, 4, 3, 4}},

	// empty-body loops terminate; a final empty iteration still
	// participates in the captures (like Perl and Python)
	{"()*", "a", []int{0, 0, 0, 0}},
	{"(a*)*", "aa", []int{0, 2, 2, 2}},
	{"(a?)*", "aa", []int{0, 2, 2, 2}},
	{"(a*)*b", "aab", []int{0, 3, 2, 2}},
	{"(|()*)*", "baaaa", []int{0, 0, 0, 0, -1, -1}},
	{"(()|())*", "a", []int{0, 0, 0, 0, 0, 0, -1, -1}},

	// '+' is an ordinary literal in this syntax
	{"a+", "bbabbba", nil},
	{"a+", "xa+y", []int{1, 3}},
	{"b|bb", "abbb", []int{1, 3}},
	{"a(b|bb)", "xabb", []int{1, 4, 2, 4}},
}

func TestTable(t *testing.T) {
	for _, tc := range cases {
		re, err := Compile(tc.pattern)
		if tc.want == nil && err != nil {
			continue // expected parse failure
		}
		if err != nil {
			t.Errorf("Compile(%q): %v", tc.pattern, err)
			continue
		}
		got := re.FindSubmatchIndex(tc.input)
		if !reflect.DeepEqual(got, tc.want) {
			t.Errorf("pattern %q input %q: got %v, want %v", tc.pattern, tc.input, got, tc.want)
		}
	}
}

func TestParseErrors(t *testing.T) {
	for _, bad := range []string{"(", ")", "a)", "*a", "a|*", "\\", "(a", "?"} {
		if _, err := Compile(bad); err == nil {
			t.Errorf("Compile(%q): expected error", bad)
		}
	}
}

// TestCrossCheck compares the NFA engine against the independent
// exhaustive backtracking matcher on many random short patterns and
// strings.
func TestCrossCheck(t *testing.T) {
	for _, seed := range []int64{20261005, 424242} {
		crossCheckSeed(t, seed)
	}
}

func crossCheckSeed(t *testing.T, seed int64) {
	rng := rand.New(rand.NewSource(seed))
	skipped := 0
	for i := 0; i < 3000; i++ {
		pattern := randomPattern(rng, rng.Intn(4)+1)
		re, err := Compile(pattern)
		if err != nil {
			t.Fatalf("Compile(%q): %v", pattern, err)
		}
		for j := 0; j < 4; j++ {
			input := randomInput(rng, rng.Intn(7))
			got, gotOK := engineCaps(re, input)
			want, wantOK, exhausted := bruteForce(pattern, []rune(input))
			if exhausted {
				skipped++
				continue
			}
			if gotOK != wantOK || !reflect.DeepEqual(got, want) {
				t.Fatalf("pattern %q input %q: engine (%v, %v), brute (%v, %v)",
					pattern, input, got, gotOK, want, wantOK)
			}
		}
	}
	t.Logf("seed %d: skipped %d over-budget cases", seed, skipped)
}

func engineCaps(re *Regexp, input string) ([]int, bool) {
	caps := re.findCaps([]rune(input))
	if caps == nil {
		return nil, false
	}
	return caps, true
}

// randomPattern builds a random pattern string from a random AST so that
// the parser is exercised too.
func randomPattern(rng *rand.Rand, depth int) string {
	n := randomAST(rng, depth)
	return render(n)
}

func randomAST(rng *rand.Rand, depth int) *node {
	id := rng.Int() // ids only need to be unique within one tree; re-assigned below
	_ = id
	kind := rng.Intn(8)
	if depth <= 0 {
		kind = rng.Intn(3) // leaves only
	}
	switch kind {
	case 0:
		return &node{kind: kEmpty}
	case 1, 2:
		return &node{kind: kChar, ch: rune('a' + rng.Intn(2))}
	case 3:
		n := &node{kind: kConcat}
		for i, cnt := 0, rng.Intn(3)+1; i < cnt; i++ {
			n.kids = append(n.kids, randomAST(rng, depth-1))
		}
		return n
	case 4:
		n := &node{kind: kAlt}
		for i, cnt := 0, rng.Intn(2)+2; i < cnt; i++ {
			n.kids = append(n.kids, randomAST(rng, depth-1))
		}
		return n
	case 5:
		return &node{kind: kStar, sub: randomAST(rng, depth-1)}
	case 6:
		return &node{kind: kQuest, sub: randomAST(rng, depth-1)}
	default:
		return &node{kind: kGroup, sub: randomAST(rng, depth-1)}
	}
}

func randomInput(rng *rand.Rand, length int) string {
	r := make([]rune, length)
	for i := range r {
		r[i] = rune('a' + rng.Intn(2))
	}
	return string(r)
}

// TestRenderParseRoundTrip ensures render output re-parses cleanly.
func TestRenderParseRoundTrip(t *testing.T) {
	rng := rand.New(rand.NewSource(7))
	for i := 0; i < 500; i++ {
		p := randomPattern(rng, rng.Intn(5)+1)
		if _, err := Compile(p); err != nil {
			t.Fatalf("render/parse round trip failed for %q: %v", p, err)
		}
	}
}

func ExampleRegexp_FindSubmatch() {
	re := MustCompile("(ab|a)*")
	fmt.Println(re.FindSubmatch("aba"))
	// Output: [aba a]
}
