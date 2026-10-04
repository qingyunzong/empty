package tmplex

import (
	"math/rand"
	"strings"
	"testing"
)

// lexAll scans src in a single Feed plus Close.
func lexAll(src string) []Token {
	lx := New()
	toks := lx.Feed([]byte(src))
	return append(toks, lx.Close()...)
}

// lexChunked scans src through the given blocks.
func lexChunked(src string, blocks ...string) []Token {
	lx := New()
	var toks []Token
	for _, b := range blocks {
		toks = append(toks, lx.Feed([]byte(b))...)
	}
	return append(toks, lx.Close()...)
}

func kinds(toks []Token) []Kind {
	ks := make([]Kind, len(toks))
	for i, t := range toks {
		ks[i] = t.Kind
	}
	return ks
}

func equalTokens(a, b []Token) bool {
	if len(a) != len(b) {
		return false
	}
	for i := range a {
		if a[i] != b[i] {
			return false
		}
	}
	return true
}

func dump(toks []Token) string {
	var sb strings.Builder
	for _, tok := range toks {
		sb.WriteString(tok.Kind.String())
		sb.WriteByte('[')
		sb.WriteString(itoa(tok.Start))
		sb.WriteByte(',')
		sb.WriteString(itoa(tok.End))
		sb.WriteString(") ")
	}
	return sb.String()
}

func itoa(n int) string {
	if n == 0 {
		return "0"
	}
	var buf [20]byte
	i := len(buf)
	for n > 0 {
		i--
		buf[i] = byte('0' + n%10)
		n /= 10
	}
	return string(buf[i:])
}

// checkCoverage verifies that token ranges are contiguous and exactly
// cover the whole input.
func checkCoverage(t *testing.T, src string, toks []Token) {
	t.Helper()
	pos := 0
	for _, tok := range toks {
		if tok.Start != pos {
			t.Fatalf("gap/overlap at token %v: want start %d, got %d\ntoks: %s",
				tok.Kind, pos, tok.Start, dump(toks))
		}
		if tok.End < tok.Start || tok.End > len(src) {
			t.Fatalf("bad range [%d,%d) for len %d", tok.Start, tok.End, len(src))
		}
		pos = tok.End
	}
	if pos != len(src) {
		t.Fatalf("tokens cover %d of %d bytes\ntoks: %s", pos, len(src), dump(toks))
	}
}

func expectKinds(t *testing.T, src string, want ...Kind) []Token {
	t.Helper()
	toks := lexAll(src)
	checkCoverage(t, src, toks)
	got := kinds(toks)
	if len(got) != len(want) {
		t.Fatalf("src %q: got %d tokens %v, want %d %v\ntoks: %s",
			src, len(got), got, len(want), want, dump(toks))
	}
	for i := range want {
		if got[i] != want[i] {
			t.Fatalf("src %q: token %d = %v, want %v\ntoks: %s",
				src, i, got[i], want[i], dump(toks))
		}
	}
	return toks
}

func TestBasic(t *testing.T) {
	src := "hello {{ name }}!"
	toks := expectKinds(t, src, Text, Open, Whitespace, Ident, Whitespace, Close, Text)
	if got := src[toks[3].Start:toks[3].End]; got != "name" {
		t.Fatalf("ident bytes = %q, want %q", got, "name")
	}
	if got := src[toks[1].Start:toks[1].End]; got != "{{" {
		t.Fatalf("open bytes = %q", got)
	}
	if got := src[toks[5].Start:toks[5].End]; got != "}}" {
		t.Fatalf("close bytes = %q", got)
	}
}

func TestStringHidesCloseMarker(t *testing.T) {
	src := `{{ "a }} b" }}`
	toks := expectKinds(t, src, Open, Whitespace, String, Whitespace, Close)
	if got := src[toks[2].Start:toks[2].End]; got != `"a }} b"` {
		t.Fatalf("string bytes = %q", got)
	}
}

func TestSingleQuotedStringHidesCloseMarker(t *testing.T) {
	src := `{{ 'x }} y' }}`
	toks := expectKinds(t, src, Open, Whitespace, String, Whitespace, Close)
	if got := src[toks[2].Start:toks[2].End]; got != `'x }} y'` {
		t.Fatalf("string bytes = %q", got)
	}
}

func TestEscapedQuoteKeepsStringOpen(t *testing.T) {
	src := `{{ 'it\'s }} fine' }}`
	toks := expectKinds(t, src, Open, Whitespace, String, Whitespace, Close)
	if got := src[toks[2].Start:toks[2].End]; got != `'it\'s }} fine'` {
		t.Fatalf("string bytes = %q", got)
	}
}

func TestEscapedBackslashBeforeQuote(t *testing.T) {
	// "\\" is an escaped backslash, so the following quote closes.
	src := `{{ "esc\\" }}`
	toks := expectKinds(t, src, Open, Whitespace, String, Whitespace, Close)
	if got := src[toks[2].Start:toks[2].End]; got != `"esc\\"` {
		t.Fatalf("string bytes = %q", got)
	}
}

func TestNestedParens(t *testing.T) {
	src := "{{ f((1+2), g(3)) }}"
	expectKinds(t, src,
		Open, Whitespace, Ident, Punct, Punct, Number, Punct, Number,
		Punct, Punct, Whitespace, Ident, Punct, Number, Punct, Punct,
		Whitespace, Close)
}

func TestCloseMarkerInsideParensIsPunct(t *testing.T) {
	// "}}" at paren depth > 0 does not close the expression.
	src := "{{ (}} ) }}"
	expectKinds(t, src,
		Open, Whitespace, Punct, Punct, Punct, Whitespace, Punct,
		Whitespace, Close)
}

func TestUnterminatedStringRunsToEOF(t *testing.T) {
	src := `{{ "abc`
	toks := expectKinds(t, src, Open, Whitespace, String)
	if got := src[toks[2].Start:toks[2].End]; got != `"abc` {
		t.Fatalf("string bytes = %q", got)
	}
}

func TestUnterminatedExpression(t *testing.T) {
	expectKinds(t, "{{ x", Open, Whitespace, Ident)
}

func TestLoneBracesInText(t *testing.T) {
	expectKinds(t, "a { b } c", Text)
	expectKinds(t, "}{", Text)
	expectKinds(t, "{", Text)
}

func TestEmpty(t *testing.T) {
	expectKinds(t, "")
}

func TestNumbers(t *testing.T) {
	src := "{{ 3.14 1. 42 }}"
	expectKinds(t, src,
		Open, Whitespace, Number, Whitespace, Number, Whitespace, Number,
		Whitespace, Close)
}

// corpus drives the chunk-invariance tests.
var corpus = []string{
	"",
	"hello",
	"{",
	"{{",
	"{}{{",
	"}}}}",
	"{{ }}",
	"a {{ b }} c",
	"hello {{ name }}!",
	`{{ "a }} b" }}`,
	`{{ 'x }} y' }}`,
	`{{ 'it\'s }} fine' }}`,
	`{{ "esc\\" }}`,
	`{{ "unterminated`,
	`{{ 'unterminated`,
	"{{ x",
	"{{ f((1+2), g(3)) }}",
	"{{ (}} ) }}",
	"{{ ((}})) }}",
	"text with { lone } braces",
	"}{{",
	"a{{b}}{{c}}d",
	"{{ 3.14 }} {{ 1. }} {{ 007 }}",
	"{{ a.b(c, [1,2]) }}",
	"{{ \"}}{{\" }}",
	"line1\n{{ x +\n y }}\nline3\n",
	"{{ _x9 9x }}",
	"{{ 'a' \"b\" 'c' }}",
}

func TestTwoWaySplitEverywhere(t *testing.T) {
	for _, src := range corpus {
		want := lexAll(src)
		checkCoverage(t, src, want)
		for i := 0; i <= len(src); i++ {
			got := lexChunked(src, src[:i], src[i:])
			if !equalTokens(got, want) {
				t.Fatalf("src %q split at %d:\n got: %s\nwant: %s",
					src, i, dump(got), dump(want))
			}
		}
	}
}

func TestByteAtATime(t *testing.T) {
	for _, src := range corpus {
		want := lexAll(src)
		blocks := make([]string, len(src))
		for i := range src {
			blocks[i] = src[i : i+1]
		}
		got := lexChunked(src, blocks...)
		if !equalTokens(got, want) {
			t.Fatalf("src %q byte-at-a-time:\n got: %s\nwant: %s",
				src, dump(got), dump(want))
		}
	}
}

// randomTemplate builds a pseudo-random template mixing text, nested
// expressions, and strings containing delimiter look-alikes.
func randomTemplate(r *rand.Rand) string {
	var b strings.Builder
	parts := 1 + r.Intn(6)
	for p := 0; p < parts; p++ {
		switch r.Intn(3) {
		case 0:
			genText(r, &b)
		default:
			b.WriteString("{{")
			genExpr(r, &b, 0)
			b.WriteString("}}")
		}
	}
	return b.String()
}

func genText(r *rand.Rand, b *strings.Builder) {
	const alpha = "ab {}\n\t_\"'\\"
	n := r.Intn(12)
	prev := byte(0)
	for i := 0; i < n; i++ {
		c := alpha[r.Intn(len(alpha))]
		// Keep "{{" out of literal text so the generated template
		// stays well-formed; the lexer itself is tested against
		// stray braces by the corpus above.
		if c == '{' && prev == '{' {
			c = 'x'
		}
		b.WriteByte(c)
		prev = c
	}
}

func genString(r *rand.Rand, b *strings.Builder) {
	quote := byte('"')
	if r.Intn(2) == 0 {
		quote = '\''
	}
	const alpha = "ab }{}('\\\"\n"
	b.WriteByte(quote)
	n := r.Intn(8)
	for i := 0; i < n; i++ {
		c := alpha[r.Intn(len(alpha))]
		if c == quote || c == '\\' {
			b.WriteByte('\\')
		}
		b.WriteByte(c)
	}
	b.WriteByte(quote)
}

func genExpr(r *rand.Rand, b *strings.Builder, depth int) {
	terms := 1 + r.Intn(3)
	for i := 0; i < terms; i++ {
		if i > 0 {
			b.WriteString([]string{" + ", ",", " * ", "-", ""}[r.Intn(5)])
		}
		switch {
		case depth < 3 && r.Intn(4) == 0:
			b.WriteByte('(')
			genExpr(r, b, depth+1)
			b.WriteByte(')')
		case r.Intn(3) == 0:
			genString(r, b)
		case r.Intn(2) == 0:
			b.WriteString([]string{"x", "foo", "_b2", "nil"}[r.Intn(4)])
		default:
			b.WriteString([]string{"0", "42", "3.14", "1."}[r.Intn(4)])
		}
	}
}

func TestRandomChunkingMatchesFullScan(t *testing.T) {
	for seed := int64(0); seed < 300; seed++ {
		r := rand.New(rand.NewSource(seed))
		src := randomTemplate(r)
		want := lexAll(src)
		checkCoverage(t, src, want)

		// Random block boundaries, including empty blocks.
		var blocks []string
		for pos := 0; pos < len(src); {
			n := 1 + r.Intn(9)
			if n > len(src)-pos {
				n = len(src) - pos
			}
			blocks = append(blocks, src[pos:pos+n])
			pos += n
		}
		got := lexChunked(src, blocks...)
		if !equalTokens(got, want) {
			t.Fatalf("seed %d src %q blocks %q:\n got: %s\nwant: %s",
				seed, src, blocks, dump(got), dump(want))
		}
	}
}

func TestFeedAfterClosePanics(t *testing.T) {
	defer func() {
		if recover() == nil {
			t.Fatal("expected panic")
		}
	}()
	lx := New()
	lx.Close()
	lx.Feed([]byte("x"))
}
