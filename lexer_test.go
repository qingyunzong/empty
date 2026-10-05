package lexer

import (
	"reflect"
	"strings"
	"testing"
)

// allChunkings returns every way to split s into one or more chunks.
func allChunkings(s string) [][]string {
	n := len(s)
	if n == 0 {
		return [][]string{{""}}
	}
	var out [][]string
	for mask := 0; mask < 1<<uint(n-1); mask++ {
		var chunks []string
		last := 0
		for i := 0; i < n-1; i++ {
			if mask&(1<<uint(i)) != 0 {
				chunks = append(chunks, s[last:i+1])
				last = i + 1
			}
		}
		chunks = append(chunks, s[last:])
		out = append(out, chunks)
	}
	return out
}

func checkEqual(t *testing.T, input string, chunks []string, wantToks, wantErrs []Token, gotToks []Token, wantE, gotE []Error) {
	t.Helper()
	if !reflect.DeepEqual(gotToks, wantToks) {
		t.Fatalf("input %q chunks %q:\n tokens differ\n want: %v\n got:  %v", input, chunks, wantToks, gotToks)
	}
	if !reflect.DeepEqual(gotE, wantE) {
		t.Fatalf("input %q chunks %q:\n errors differ\n want: %v\n got:  %v", input, chunks, wantE, gotE)
	}
}

// TestExhaustiveChunking feeds each input in every possible chunking and
// requires tokens and errors to match the one-shot read exactly.
func TestExhaustiveChunking(t *testing.T) {
	inputs := []string{
		`a`,
		`ab c`,
		`1.5 x`,
		`"s"`,
		`"a\"b"`,
		`"a\\"`,
		`"unterm`,
		`"bad` + "\n" + `next`,
		`//c`,
		"//c\nx",
		`/*c*/`,
		`/*a/*b*/c*/`,
		`/*/`,
		`/*unterm`,
		`a/"b"`,
		`/"*/"`,
		`x/*c*/y`,
		`"/*"*/`,
		`*/`,
		`1.`,
	}
	for _, input := range inputs {
		wantToks, wantErrs := Lex(input)
		for _, chunks := range allChunkings(input) {
			gotToks, gotErrs := Lex(chunks...)
			checkEqual(t, input, chunks, wantToks, nil, gotToks, wantErrs, gotErrs)
		}
	}
}

// TestChunkedVsOneShot covers longer inputs with every two-way split,
// byte-at-a-time feeding, and several fixed chunk sizes.
func TestChunkedVsOneShot(t *testing.T) {
	inputs := []string{
		`foo bar_2 123 45.6 + * / =`,
		`say "hello \"world\"!" // done` + "\n" + `next`,
		`a /* outer /* inner */ still outer */ b`,
		`/* a */ /* b */ /* c */`,
		"line1 // tail\nline2 /* block\nspanning lines */ end",
		`"str1" "str2" "str3"`,
		"x = \"esc \\\\\" + \"q\\\"\" + \"done\"",
		`pre "unterminated string at eof`,
		`pre /* unterminated comment at eof`,
		`pre /* nested /* unterminated`,
		"stray \"newline\nin string\" after",
		`/*/ tricky /*/ seq */`,
		`a/b//c` + "\n" + `d/*e*/f`,
		`"//not comment" /* "not string" */`,
		`3.14 2. 5..6 7.`,
	}
	for _, input := range inputs {
		wantToks, wantErrs := Lex(input)

		// Every two-way split.
		for i := 0; i <= len(input); i++ {
			gotToks, gotErrs := Lex(input[:i], input[i:])
			checkEqual(t, input, []string{input[:i], input[i:]}, wantToks, nil, gotToks, wantErrs, gotErrs)
		}
		// Byte at a time.
		var ones []string
		for i := 0; i < len(input); i++ {
			ones = append(ones, input[i:i+1])
		}
		gotToks, gotErrs := Lex(ones...)
		checkEqual(t, input, ones, wantToks, nil, gotToks, wantErrs, gotErrs)
		// Fixed chunk sizes.
		for _, size := range []int{2, 3, 5, 7} {
			var chunks []string
			for i := 0; i < len(input); i += size {
				end := i + size
				if end > len(input) {
					end = len(input)
				}
				chunks = append(chunks, input[i:end])
			}
			gotToks, gotErrs := Lex(chunks...)
			checkEqual(t, input, chunks, wantToks, nil, gotToks, wantErrs, gotErrs)
		}
	}
}

func TestTokensAndPositions(t *testing.T) {
	input := "foo 1.5 \"a\\tb\" // hi\n/* x /* y */ z */ +"
	toks, errs := Lex(input)
	if len(errs) != 0 {
		t.Fatalf("unexpected errors: %v", errs)
	}
	want := []Token{
		{Ident, 0, 3, "foo"},
		{Number, 4, 7, "1.5"},
		{String, 8, 14, `"a\tb"`},
		{LineComment, 15, 20, "// hi"},
		{BlockComment, 21, 38, "/* x /* y */ z */"},
		{Punct, 39, 40, "+"},
	}
	if !reflect.DeepEqual(toks, want) {
		t.Fatalf("tokens:\n want: %v\n got:  %v", want, toks)
	}
	// Positions must count original bytes.
	for _, tok := range toks {
		if input[tok.Start:tok.End] != tok.Text {
			t.Fatalf("token %v does not match source slice %q", tok, input[tok.Start:tok.End])
		}
	}
}

func TestEOFErrorDistinction(t *testing.T) {
	cases := []struct {
		input string
		want  []Error
	}{
		{`abc "open`, []Error{{4, ErrUnterminatedString}}},
		{`abc /*open`, []Error{{4, ErrUnterminatedBlockComment}}},
		{`/* a /* b */`, []Error{{0, ErrUnterminatedBlockComment}}},
		{`"esc\`, []Error{{0, ErrUnterminatedString}}},
		{`"ok" /* x`, []Error{{5, ErrUnterminatedBlockComment}}},
		{`/* x */ "y`, []Error{{8, ErrUnterminatedString}}},
		{"\"nl\n", []Error{{0, ErrUnterminatedString}}},
	}
	for _, tc := range cases {
		_, errs := Lex(tc.input)
		if !reflect.DeepEqual(errs, tc.want) {
			t.Fatalf("input %q:\n want errors: %v\n got:  %v", tc.input, tc.want, errs)
		}
	}
}

func TestEmptyAndWhitespace(t *testing.T) {
	for _, input := range []string{"", "   ", " \t\n\r "} {
		toks, errs := Lex(input)
		if len(toks) != 0 || len(errs) != 0 {
			t.Fatalf("input %q: got tokens %v errors %v", input, toks, errs)
		}
	}
}

func TestNestedCommentDepth(t *testing.T) {
	input := `/* 1 /* 2 /* 3 */ 2 */ 1 */ x`
	toks, errs := Lex(input)
	if len(errs) != 0 {
		t.Fatalf("unexpected errors: %v", errs)
	}
	if len(toks) != 2 || toks[0].Kind != BlockComment || toks[0].Text != input[:len(input)-2] {
		t.Fatalf("unexpected tokens: %v", toks)
	}
	if toks[1] != (Token{Ident, len(input) - 1, len(input), "x"}) {
		t.Fatalf("unexpected trailing token: %v", toks[1])
	}
}

func TestLineCommentAtEOF(t *testing.T) {
	toks, errs := Lex("// no newline")
	if len(errs) != 0 {
		t.Fatalf("unexpected errors: %v", errs)
	}
	if len(toks) != 1 || toks[0] != (Token{LineComment, 0, 13, "// no newline"}) {
		t.Fatalf("unexpected tokens: %v", toks)
	}
}

func TestStringEscapes(t *testing.T) {
	input := `"a\"b" "c\\" "d\n"`
	toks, errs := Lex(input)
	if len(errs) != 0 {
		t.Fatalf("unexpected errors: %v", errs)
	}
	want := []string{`"a\"b"`, `"c\\"`, `"d\n"`}
	if len(toks) != len(want) {
		t.Fatalf("want %d tokens, got %v", len(want), toks)
	}
	for i, w := range want {
		if toks[i].Kind != String || toks[i].Text != w {
			t.Fatalf("token %d: want String %q, got %v", i, w, toks[i])
		}
	}
	if !strings.HasPrefix(toks[0].Text, `"a\`) {
		t.Fatalf("escape not preserved: %v", toks[0])
	}
}
