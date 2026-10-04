package regex

import (
	"fmt"
	"math/rand"
	"reflect"
	"strings"
	"testing"
)

// check compares the Pike VM against the independent exhaustive
// backtracking matcher for one pattern and one input string.
func check(t *testing.T, pat, s string) {
	t.Helper()
	re, err := Compile(pat)
	if err != nil {
		t.Fatalf("Compile(%q): %v", pat, err)
	}
	gotCaps, gotOK := re.Find(s)
	wantCaps, wantOK, err := re.findExhaustive(s)
	if err == errTooManyParses {
		t.Skipf("pattern %q string %q: %v", pat, s, err)
	}
	if err != nil {
		t.Fatalf("findExhaustive(%q, %q): %v", pat, s, err)
	}
	if gotOK != wantOK {
		t.Fatalf("Find(%q, %q): ok=%v, exhaustive ok=%v", pat, s, gotOK, wantOK)
	}
	if gotOK && !reflect.DeepEqual(gotCaps, wantCaps) {
		t.Fatalf("Find(%q, %q): caps=%v, exhaustive caps=%v", pat, s, gotCaps, wantCaps)
	}
}

// allStrings yields every string over alphabet of length up to maxLen.
func allStrings(alphabet string, maxLen int) []string {
	var out []string
	var rec func(cur string, n int)
	rec = func(cur string, n int) {
		out = append(out, cur)
		if n == 0 {
			return
		}
		for _, c := range alphabet {
			rec(cur+string(c), n-1)
		}
	}
	rec("", maxLen)
	return out
}

// randAST generates a random pattern AST of bounded depth.
func randAST(r *rand.Rand, depth int, groups *int) *node {
	lit := func() *node {
		return &node{kind: kLit, c: byte('a' + r.Intn(2))}
	}
	if depth == 0 {
		return lit()
	}
	switch r.Intn(6) {
	case 0:
		return lit()
	case 1:
		n := 1 + r.Intn(3)
		parts := make([]*node, n)
		for i := range parts {
			parts[i] = randAST(r, depth-1, groups)
		}
		return &node{kind: kConcat, children: parts}
	case 2:
		n := 2 + r.Intn(2)
		branches := make([]*node, n)
		for i := range branches {
			branches[i] = randAST(r, depth-1, groups)
		}
		return &node{kind: kAlt, children: branches}
	case 3:
		return &node{kind: kStar, children: []*node{randAST(r, depth-1, groups)}}
	case 4:
		return &node{kind: kQuest, children: []*node{randAST(r, depth-1, groups)}}
	default:
		idx := *groups
		*groups++
		return &node{kind: kGroup, groupIdx: idx, children: []*node{randAST(r, depth-1, groups)}}
	}
}

// render converts an AST back into a pattern string.
func render(n *node) string {
	var b strings.Builder
	var walk, wrap func(n *node)
	walk = func(n *node) {
		switch n.kind {
		case kLit:
			b.WriteByte(n.c)
		case kConcat:
			for _, c := range n.children {
				walk(c)
			}
		case kAlt:
			for i, br := range n.children {
				if i > 0 {
					b.WriteByte('|')
				}
				walk(br)
			}
		case kStar:
			wrap(n.children[0])
		case kQuest:
			wrap(n.children[0])
		case kGroup:
			b.WriteByte('(')
			walk(n.children[0])
			b.WriteByte(')')
		}
	}
	wrap = func(n *node) {
		// parenthesize anything that is not a single literal or group
		if n.kind == kLit {
			walk(n)
		} else {
			b.WriteByte('(')
			walk(n)
			b.WriteByte(')')
		}
	}
	walk(n)
	s := b.String()
	if n.kind == kStar || n.kind == kQuest {
		return "(" + s + ")"
	}
	return s
}

func TestCrossCheckTrickyPatterns(t *testing.T) {
	patterns := []string{
		"(a?)*", "(a*)*", "(a|b)*", "((a)|b)*", "(a|ab)(c|bcd)(d*)",
		"(ab|a)(b?)", "(a|ab)*", "(a?)(a?)", "(a*)(a*)", "((a)*)*",
		"(a|)", "(a|)*", "a?a?", "(a?)*a", "(a|b)*abb", "(b|a|ab)*",
		"((a*)(b*))*", "(a(b?)*)*", "(|a)*", "(a??)*",
	}
	stringsToTry := append(allStrings("ab", 5), "abcd", "aabb", "abab", "aaabbb")
	for _, pat := range patterns {
		for _, s := range stringsToTry {
			check(t, pat, s)
		}
	}
}

func TestCrossCheckRandom(t *testing.T) {
	r := rand.New(rand.NewSource(1))
	stringsToTry := allStrings("ab", 4)
	for iter := 0; iter < 400; iter++ {
		groups := 1
		pat := render(randAST(r, 3, &groups))
		if _, err := Compile(pat); err != nil {
			t.Fatalf("generated pattern %q does not compile: %v", pat, err)
		}
		for _, s := range stringsToTry {
			check(t, pat, s)
		}
	}
}

func TestCrossCheckExhaustiveTiny(t *testing.T) {
	// Every pattern up to 3 atoms over a tiny grammar, every string up
	// to length 4.
	atoms := []string{"a", "b", "(a)", "(a|b)", "a*", "a?", "(a|b)*", "(aa|a)*"}
	pats := map[string]bool{}
	for _, x := range atoms {
		pats[x] = true
		for _, y := range atoms {
			pats[x+y] = true
			pats[x+"|"+y] = true
			for _, z := range atoms {
				pats[x+y+z] = true
			}
		}
	}
	stringsToTry := allStrings("ab", 4)
	for pat := range pats {
		for _, s := range stringsToTry {
			check(t, pat, s)
		}
	}
}

func ExampleRegexp_Find() {
	re, _ := Compile("(a|ab)(c|bcd)(d*)")
	caps, _ := re.Find("abcd")
	fmt.Println(caps)
	// Output: [0 4 0 1 1 4 4 4]
}
