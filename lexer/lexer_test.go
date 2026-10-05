package lexer

import (
	"errors"
	"reflect"
	"strings"
	"testing"
)

// edge is a DFA transition from state from to state to on byte sym.
type edge struct {
	from, to int
	sym      byte
}

// mkRule builds a DFA-table rule from a start state, accepting states and
// explicit edges. States are numbered 0..max.
func mkRule(name string, start int, accepts []int, edges ...edge) Rule {
	n := start + 1
	for _, a := range accepts {
		if a+1 > n {
			n = a + 1
		}
	}
	for _, e := range edges {
		if e.from+1 > n {
			n = e.from + 1
		}
		if e.to+1 > n {
			n = e.to + 1
		}
	}
	trans := make([][]int, n)
	for s := range trans {
		trans[s] = make([]int, 256)
		for c := range trans[s] {
			trans[s][c] = -1
		}
	}
	for _, e := range edges {
		trans[e.from][e.sym] = e.to
	}
	accept := make([]bool, n)
	for _, a := range accepts {
		accept[a] = true
	}
	return Rule{Name: name, Start: start, Trans: trans, Accept: accept}
}

// rangeEdges builds one edge per byte in [lo, hi].
func rangeEdges(from, to int, lo, hi byte) []edge {
	var out []edge
	for c := lo; c <= hi; c++ {
		out = append(out, edge{from, to, c})
	}
	return out
}

// abRules exercises longest-match vs declaration-order competition:
//
//	ab+  (rule 0) competes with abc (rule 1) and a (rule 2)
//	c+   (rule 3) ties with c (rule 4) at length 1 -> rule 3 must win
func abRules() []Rule {
	return []Rule{
		mkRule("abPlus", 0, []int{2},
			edge{0, 1, 'a'}, edge{1, 2, 'b'}, edge{2, 2, 'b'}),
		mkRule("abc", 0, []int{3},
			edge{0, 1, 'a'}, edge{1, 2, 'b'}, edge{2, 3, 'c'}),
		mkRule("a", 0, []int{1},
			edge{0, 1, 'a'}),
		mkRule("cPlus", 0, []int{1},
			edge{0, 1, 'c'}, edge{1, 1, 'c'}),
		mkRule("c", 0, []int{1},
			edge{0, 1, 'c'}),
	}
}

// kwRules exercises keyword vs identifier: "if" ties with [a-z]+ at
// length 2, so declaration order must pick the keyword.
func kwRules() []Rule {
	ident := append(rangeEdges(0, 1, 'a', 'z'), rangeEdges(1, 1, 'a', 'z')...)
	return []Rule{
		mkRule("if", 0, []int{2},
			edge{0, 1, 'i'}, edge{1, 2, 'f'}),
		mkRule("ident", 0, []int{1}, ident...),
	}
}

// lexChunked feeds s through the lexer in the given chunks and returns the
// emitted tokens plus the first error seen across Write/End calls.
func lexChunked(chunks []string, rules []Rule) ([]Token, error) {
	var toks []Token
	lx := New(func(t Token) { toks = append(toks, t) }, rules...)
	var err error
	for _, c := range chunks {
		if e := lx.Write([]byte(c)); e != nil && err == nil {
			err = e
		}
	}
	if e := lx.End(); e != nil && err == nil {
		err = e
	}
	return toks, err
}

// allChunkings enumerates every way to cut s into non-empty pieces.
func allChunkings(s string) [][]string {
	if s == "" {
		return [][]string{{}}
	}
	var out [][]string
	for mask := 0; mask < 1<<(len(s)-1); mask++ {
		var chunks []string
		start := 0
		for i := 0; i < len(s)-1; i++ {
			if mask&(1<<i) != 0 {
				chunks = append(chunks, s[start:i+1])
				start = i + 1
			}
		}
		chunks = append(chunks, s[start:])
		out = append(out, chunks)
	}
	return out
}

// allStrings enumerates all strings over alphabet of length 0..maxLen.
func allStrings(alphabet string, maxLen int) []string {
	out := []string{""}
	cur := []string{""}
	for l := 0; l < maxLen; l++ {
		var next []string
		for _, s := range cur {
			for i := 0; i < len(alphabet); i++ {
				next = append(next, s+alphabet[i:i+1])
			}
		}
		out = append(out, next...)
		cur = next
	}
	return out
}

func errPos(err error) (pos int, ok bool) {
	var le *Error
	if errors.As(err, &le) {
		return le.Pos, true
	}
	return 0, false
}

// checkChunkedVsWhole verifies that every chunking of s reproduces the
// whole-string token stream and error position exactly.
func checkChunkedVsWhole(t *testing.T, rules []Rule, s string) {
	t.Helper()
	wantToks, wantErr := Tokenize(s, rules...)
	wantPos, wantIsErr := errPos(wantErr)
	for _, chunks := range allChunkings(s) {
		gotToks, gotErr := lexChunked(chunks, rules)
		gotPos, gotIsErr := errPos(gotErr)
		if gotIsErr != wantIsErr || (wantIsErr && gotPos != wantPos) {
			t.Errorf("input %q chunks %q: error = %v, want %v", s, chunks, gotErr, wantErr)
			continue
		}
		if !reflect.DeepEqual(gotToks, wantToks) {
			t.Errorf("input %q chunks %q:\n got %v\nwant %v", s, chunks, wantToks, gotToks)
		}
	}
}

// TestChunkedVsWhole enumerates all short inputs over each rule set's
// alphabet and compares every possible chunking against whole-string
// tokenization.
func TestChunkedVsWhole(t *testing.T) {
	t.Run("ab", func(t *testing.T) {
		rules := abRules()
		for _, s := range allStrings("abc", 6) {
			checkChunkedVsWhole(t, rules, s)
		}
	})
	t.Run("keyword", func(t *testing.T) {
		rules := kwRules()
		for _, s := range allStrings("ifj", 6) {
			checkChunkedVsWhole(t, rules, s)
		}
	})
}

// TestLongestMatchThenDeclarationOrder pins the conflict-resolution table.
func TestLongestMatchThenDeclarationOrder(t *testing.T) {
	cases := []struct {
		input string
		rule  int
		text  string
	}{
		{"abc", 1, "abc"},  // abc (len 3) beats ab+ (len 2)
		{"abb", 0, "abb"},  // ab+ extends, abc dies
		{"abbc", 0, "abb"}, // longest ab+ prefix, then c+ follows
		{"a", 2, "a"},      // only rule a matches
		{"c", 3, "c"},      // c+ ties c at len 1: earlier rule wins
		{"cc", 3, "cc"},    // c+ extends to len 2
		{"abca", 1, "abc"}, // abc then a
	}
	rules := abRules()
	for _, tc := range cases {
		toks, err := Tokenize(tc.input, rules...)
		if err != nil {
			t.Fatalf("Tokenize(%q): %v", tc.input, err)
		}
		if len(toks) == 0 || toks[0].Rule != tc.rule || toks[0].Text != tc.text {
			t.Errorf("Tokenize(%q)[0] = %+v, want rule %d text %q", tc.input, toks[0], tc.rule, tc.text)
		}
	}
	kw := kwRules()
	toks, err := Tokenize("if", kw...)
	if err != nil || len(toks) != 1 || toks[0].Name != "if" {
		t.Errorf(`Tokenize("if") = %v, %v; want single "if" keyword token`, toks, err)
	}
	toks, err = Tokenize("ifj", kw...)
	if err != nil || len(toks) != 1 || toks[0].Name != "ident" || toks[0].Text != "ifj" {
		t.Errorf(`Tokenize("ifj") = %v, %v; want single ident "ifj"`, toks, err)
	}
}

// TestTailTokenHeldUntilEnd: a match whose DFA is still alive at the end of
// a chunk must not be emitted; only End finalizes the tail token.
func TestTailTokenHeldUntilEnd(t *testing.T) {
	var toks []Token
	lx := New(func(tk Token) { toks = append(toks, tk) }, abRules()...)
	if err := lx.Write([]byte("a")); err != nil {
		t.Fatal(err)
	}
	if len(toks) != 0 {
		t.Fatalf("token emitted after partial chunk: %v", toks)
	}
	if err := lx.Write([]byte("b")); err != nil {
		t.Fatal(err)
	}
	if len(toks) != 0 {
		t.Fatalf("token emitted while ab+ can still extend: %v", toks)
	}
	if err := lx.End(); err != nil {
		t.Fatal(err)
	}
	want := []Token{{Rule: 0, Name: "abPlus", Text: "ab", Start: 0}}
	if !reflect.DeepEqual(toks, want) {
		t.Errorf("got %v, want %v", toks, want)
	}
}

// TestDecidedTokenEmittedDuringWrite: once every DFA dies, the decided
// token is emitted immediately, while the still-extendable tail waits.
func TestDecidedTokenEmittedDuringWrite(t *testing.T) {
	var toks []Token
	rules := []Rule{
		mkRule("a", 0, []int{1}, edge{0, 1, 'a'}),
		mkRule("bPlus", 0, []int{1}, edge{0, 1, 'b'}, edge{1, 1, 'b'}),
	}
	lx := New(func(tk Token) { toks = append(toks, tk) }, rules...)
	if err := lx.Write([]byte("abb")); err != nil {
		t.Fatal(err)
	}
	// "a" is decided (no rule can extend past it), "bb" may still extend.
	want := []Token{{Rule: 0, Name: "a", Text: "a", Start: 0}}
	if !reflect.DeepEqual(toks, want) {
		t.Fatalf("after Write: got %v, want %v", toks, want)
	}
	if err := lx.End(); err != nil {
		t.Fatal(err)
	}
	want = append(want, Token{Rule: 1, Name: "bPlus", Text: "bb", Start: 1})
	if !reflect.DeepEqual(toks, want) {
		t.Fatalf("after End: got %v, want %v", toks, want)
	}
}

// TestErrorPosition checks that unmatched input reports the absolute offset
// and that already-decided tokens are still delivered first.
func TestErrorPosition(t *testing.T) {
	toks, err := Tokenize("cad", abRules()...)
	if len(toks) != 2 || toks[0].Text != "c" || toks[1].Text != "a" {
		t.Errorf("tokens before error = %v, want [c a]", toks)
	}
	pos, ok := errPos(err)
	if !ok || pos != 2 {
		t.Errorf("error = %v, want *Error at pos 2", err)
	}

	// Same for a dangling partial match at end of input.
	abc := mkRule("abc", 0, []int{3},
		edge{0, 1, 'a'}, edge{1, 2, 'b'}, edge{2, 3, 'c'})
	_, err = Tokenize("ab", abc)
	pos, ok = errPos(err)
	if !ok || pos != 0 {
		t.Errorf("error = %v, want *Error at pos 0", err)
	}
}

// TestStreamErrorAcrossChunks: an error becomes visible exactly when the
// offending byte arrives, and is sticky afterwards.
func TestStreamErrorAcrossChunks(t *testing.T) {
	var toks []Token
	lx := New(func(tk Token) { toks = append(toks, tk) }, abRules()...)
	if err := lx.Write([]byte("ca")); err != nil {
		t.Fatalf("Write(ca): %v", err)
	}
	if err := lx.Write([]byte("d")); err == nil {
		t.Fatal("Write(d): expected error")
	} else if pos, _ := errPos(err); pos != 2 {
		t.Fatalf("error pos = %d, want 2", pos)
	}
	if len(toks) != 2 || toks[0].Text != "c" || toks[1].Text != "a" {
		t.Errorf("tokens = %v, want [c a]", toks)
	}
	if err := lx.End(); err == nil {
		t.Error("End: expected sticky error")
	}
}

// TestEndSemantics covers empty input, idempotent End, and Write after End.
func TestEndSemantics(t *testing.T) {
	var toks []Token
	lx := New(func(tk Token) { toks = append(toks, tk) }, abRules()...)
	if err := lx.End(); err != nil {
		t.Fatalf("End on empty input: %v", err)
	}
	if err := lx.End(); err != nil {
		t.Fatalf("second End: %v", err)
	}
	if err := lx.Write([]byte("a")); !errors.Is(err, ErrWriteAfterEnd) {
		t.Fatalf("Write after End = %v, want ErrWriteAfterEnd", err)
	}
	if len(toks) != 0 {
		t.Errorf("tokens = %v, want none", toks)
	}
}

// TestRuleValidation rejects malformed tables at construction.
func TestRuleValidation(t *testing.T) {
	good := mkRule("a", 0, []int{1}, edge{0, 1, 'a'})
	bad := good
	bad.Trans = [][]int{{0}} // row too short
	defer func() {
		if recover() == nil {
			t.Error("expected panic for invalid rule table")
		}
	}()
	New(func(Token) {}, bad)
}

// TestEmptyStringAcceptRejected: a rule accepting the empty string would
// loop forever, so it is rejected.
func TestEmptyStringAcceptRejected(t *testing.T) {
	defer func() {
		if recover() == nil {
			t.Error("expected panic for empty-string-accepting rule")
		}
	}()
	New(func(Token) {}, mkRule("empty", 0, []int{0}))
}

// FuzzChunkedVsWhole randomizes the enumeration of TestChunkedVsWhole.
func FuzzChunkedVsWhole(f *testing.F) {
	for _, s := range []string{"", "a", "ab", "abc", "abbc", "ccab", "abcabc"} {
		f.Add(s, uint8(0), uint8(3))
	}
	f.Fuzz(func(t *testing.T, s string, cutA, cutB uint8) {
		if strings.ContainsAny(s, "d") {
			t.Skip()
		}
		rules := abRules()
		wantToks, wantErr := Tokenize(s, rules...)
		// deterministic pseudo-chunking driven by cutA/cutB
		var chunks []string
		step := int(cutA%3) + 1
		for i := 0; i < len(s); i += step {
			j := i + step + int(cutB%2)
			if j > len(s) {
				j = len(s)
			}
			chunks = append(chunks, s[i:j])
			i = j - step
		}
		if len(chunks) == 0 {
			chunks = []string{""}
		}
		gotToks, gotErr := lexChunked(chunks, rules)
		wp, we := errPos(wantErr)
		gp, ge := errPos(gotErr)
		if we != ge || (we && wp != gp) || !reflect.DeepEqual(wantToks, gotToks) {
			t.Errorf("input %q chunks %q: got (%v, %v), want (%v, %v)",
				s, chunks, gotToks, gotErr, wantToks, wantErr)
		}
	})
}
