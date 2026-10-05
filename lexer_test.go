package tmplex

import (
	"math/rand"
	"reflect"
	"strings"
	"testing"
)

// tokenText is a test helper rendering a token with its source slice.
func tokenText(src []byte, t Token) string {
	return t.Kind.String() + "(" + string(t.Bytes(src)) + ")"
}

func lexChunked(t *testing.T, src []byte, chunks ...int) []Token {
	t.Helper()
	l := NewLexer()
	var all []Token
	off := 0
	for _, n := range chunks {
		if off+n > len(src) {
			n = len(src)
		}
		all = append(all, l.Feed(src[off:off+n])...)
		off += n
	}
	if off < len(src) {
		all = append(all, l.Feed(src[off:])...)
	}
	rest, err := l.Close()
	if err != nil {
		t.Fatalf("Close: %v", err)
	}
	return append(all, rest...)
}

func TestBasicRanges(t *testing.T) {
	src := []byte(`hello {{ name }}!`)
	toks, err := Lex(src)
	if err != nil {
		t.Fatalf("Lex: %v", err)
	}
	want := []Token{
		{TokenText, 0, 6},
		{TokenExprOpen, 6, 8},
		{TokenIdent, 9, 13},
		{TokenExprClose, 14, 16},
		{TokenText, 16, 17},
	}
	if !reflect.DeepEqual(toks, want) {
		t.Fatalf("got %v, want %v", toks, want)
	}
	for _, tok := range toks {
		if tok.Start < 0 || tok.End > len(src) || tok.Start > tok.End {
			t.Fatalf("token %v out of range", tok)
		}
	}
}

func TestStringHidesExprClose(t *testing.T) {
	src := []byte(`{{ "a }} b" }}`)
	toks, err := Lex(src)
	if err != nil {
		t.Fatalf("Lex: %v", err)
	}
	var kinds []TokenKind
	for _, tok := range toks {
		kinds = append(kinds, tok.Kind)
	}
	want := []TokenKind{TokenExprOpen, TokenString, TokenExprClose}
	if !reflect.DeepEqual(kinds, want) {
		t.Fatalf("kinds = %v, want %v", kinds, want)
	}
	if got := string(toks[1].Bytes(src)); got != `"a }} b"` {
		t.Fatalf("string token = %q", got)
	}
}

func TestStringHidesOpenMarkerAndEscapes(t *testing.T) {
	src := []byte(`{{ 'x {{ y' + "a\"b\\" }}`)
	toks, err := Lex(src)
	if err != nil {
		t.Fatalf("Lex: %v", err)
	}
	var kinds []TokenKind
	for _, tok := range toks {
		kinds = append(kinds, tok.Kind)
	}
	want := []TokenKind{TokenExprOpen, TokenString, TokenOp, TokenString, TokenExprClose}
	if !reflect.DeepEqual(kinds, want) {
		t.Fatalf("kinds = %v, want %v", kinds, want)
	}
	if got := string(toks[3].Bytes(src)); got != `"a\"b\\"` {
		t.Fatalf("string token = %q", got)
	}
}

func TestNestedParens(t *testing.T) {
	src := []byte(`{{ f(a, (b + c)) }}`)
	toks, err := Lex(src)
	if err != nil {
		t.Fatalf("Lex: %v", err)
	}
	var kinds []TokenKind
	for _, tok := range toks {
		kinds = append(kinds, tok.Kind)
	}
	want := []TokenKind{
		TokenExprOpen, TokenIdent, TokenLParen, TokenIdent, TokenPunct,
		TokenLParen, TokenIdent, TokenOp, TokenIdent,
		TokenRParen, TokenRParen, TokenExprClose,
	}
	if !reflect.DeepEqual(kinds, want) {
		t.Fatalf("kinds = %v, want %v", kinds, want)
	}
}

func TestCloseMarkerInsideParensDoesNotTerminate(t *testing.T) {
	src := []byte(`{{ (x }}) }} tail`)
	toks, err := Lex(src)
	if err != nil {
		t.Fatalf("Lex: %v", err)
	}
	var kinds []TokenKind
	for _, tok := range toks {
		kinds = append(kinds, tok.Kind)
	}
	want := []TokenKind{
		TokenExprOpen, TokenLParen, TokenIdent,
		TokenPunct, TokenPunct, // "}}" at depth 1 stays punctuation
		TokenRParen, TokenExprClose, TokenText,
	}
	if !reflect.DeepEqual(kinds, want) {
		t.Fatalf("kinds = %v, want %v", kinds, want)
	}
	if got := string(toks[len(toks)-1].Bytes(src)); got != " tail" {
		t.Fatalf("trailing text = %q", got)
	}
}

func TestModeStackSurvivesChunkBoundary(t *testing.T) {
	src := []byte(`a {{ "b`)
	l := NewLexer()
	if toks := l.Feed(src); len(toks) != 2 {
		t.Fatalf("after first feed got %d tokens: %v", len(toks), toks)
	}
	if l.Mode() != ModeString {
		t.Fatalf("mode after first feed = %v, want string", l.Mode())
	}
	rest, err := l.Close()
	if err == nil {
		t.Fatalf("expected unterminated string error, got tokens %v", rest)
	}
}

func TestEscapeSplitAcrossChunks(t *testing.T) {
	// The backslash and the quote land in different chunks; the quote
	// must still be treated as escaped.
	src := []byte(`{{ "a\"b" }}`)
	full, err := Lex(src)
	if err != nil {
		t.Fatalf("Lex: %v", err)
	}
	// Split right between the backslash and the escaped quote.
	cut := strings.Index(string(src), `\`) + 1
	chunked := lexChunked(t, src, cut)
	if !reflect.DeepEqual(chunked, full) {
		t.Fatalf("chunked %v != full %v", chunked, full)
	}
}

func TestUnterminated(t *testing.T) {
	for _, src := range []string{`{{ x`, `{{ "abc`, `{{ f(1`, `a {{ "b\`, `{{{`} {
		if _, err := Lex([]byte(src)); err == nil {
			t.Fatalf("Lex(%q): expected error", src)
		}
	}
}

func TestEmptyAndTextOnly(t *testing.T) {
	toks, err := Lex(nil)
	if err != nil || len(toks) != 0 {
		t.Fatalf("empty: toks=%v err=%v", toks, err)
	}
	src := []byte(`just { text } and }} nothing`)
	toks, err = Lex(src)
	if err != nil {
		t.Fatalf("Lex: %v", err)
	}
	if len(toks) != 1 || toks[0].Kind != TokenText || toks[0].Start != 0 || toks[0].End != len(src) {
		t.Fatalf("toks = %v", toks)
	}
}

func TestAdjacentExpressions(t *testing.T) {
	src := []byte(`{{a}}{{b}}`)
	toks, err := Lex(src)
	if err != nil {
		t.Fatalf("Lex: %v", err)
	}
	var kinds []TokenKind
	for _, tok := range toks {
		kinds = append(kinds, tok.Kind)
	}
	want := []TokenKind{
		TokenExprOpen, TokenIdent, TokenExprClose,
		TokenExprOpen, TokenIdent, TokenExprClose,
	}
	if !reflect.DeepEqual(kinds, want) {
		t.Fatalf("kinds = %v, want %v", kinds, want)
	}
}

func TestOperatorsAndNumbers(t *testing.T) {
	src := []byte(`{{ a == 1.5 && b != 2 }}`)
	toks, err := Lex(src)
	if err != nil {
		t.Fatalf("Lex: %v", err)
	}
	var got []string
	for _, tok := range toks {
		got = append(got, tokenText(src, tok))
	}
	want := []string{
		"expr-open({{)", "ident(a)", "op(==)", "number(1.5)",
		"op(&&)", "ident(b)", "op(!=)", "number(2)", "expr-close(}})",
	}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("got %v, want %v", got, want)
	}
}

// TestRandomChunkingMatchesFullScan is the core cross-check: for every
// template and every seed, feeding random byte-sized chunks must yield
// exactly the token stream of a single full scan.
func TestRandomChunkingMatchesFullScan(t *testing.T) {
	templates := []string{
		``,
		`plain text, no markers at all`,
		`{ not a marker } and } either`,
		`trailing brace {`,
		`{{name}}`,
		`hello {{ name }}!`,
		`{{a}}{{b}}{{c}}`,
		`{{ "string with }} and {{ inside" }}`,
		`{{ 'single' + "double" }}`,
		`{{ "escapes \" \\ \n done" }}`,
		`{{ 'it\'s' }}`,
		`{{ f(a, (b + (c - d))) }}`,
		`{{ (x }}) }}`,
		`{{ a == 1 && b != 2.5 || c >= 3 }}`,
		`mix {{ x }} and {{ "y }}" }} end`,
		`unicode 文本 {{ "字符串 }} 内" }} 结束`,
		`{{ "multi
line" }}`,
		`{{ n.5 }}`,
	}
	for _, tmpl := range templates {
		src := []byte(tmpl)
		full, err := Lex(src)
		if err != nil {
			t.Fatalf("Lex(%q): %v", tmpl, err)
		}
		for seed := int64(0); seed < 50; seed++ {
			rng := rand.New(rand.NewSource(seed))
			chunked := lexRandomChunks(t, src, rng)
			if !reflect.DeepEqual(chunked, full) {
				t.Fatalf("template %q seed %d:\nchunked %v\nfull    %v",
					tmpl, seed, chunked, full)
			}
		}
	}
}

func lexRandomChunks(t *testing.T, src []byte, rng *rand.Rand) []Token {
	t.Helper()
	l := NewLexer()
	var all []Token
	for off := 0; off < len(src); {
		n := 1 + rng.Intn(9)
		if n > len(src)-off {
			n = len(src) - off
		}
		all = append(all, l.Feed(src[off:off+n])...)
		off += n
	}
	rest, err := l.Close()
	if err != nil {
		t.Fatalf("Close: %v", err)
	}
	return append(all, rest...)
}

// TestRandomChunkingByteByByte stresses the worst case: one byte per
// Feed call.
func TestRandomChunkingByteByByte(t *testing.T) {
	src := []byte(`pre {{ f("a }} b", (x + 1)) }} post`)
	full, err := Lex(src)
	if err != nil {
		t.Fatalf("Lex: %v", err)
	}
	l := NewLexer()
	var chunked []Token
	for i := 0; i < len(src); i++ {
		chunked = append(chunked, l.Feed(src[i:i+1])...)
	}
	rest, err := l.Close()
	if err != nil {
		t.Fatalf("Close: %v", err)
	}
	chunked = append(chunked, rest...)
	if !reflect.DeepEqual(chunked, full) {
		t.Fatalf("byte-by-byte %v != full %v", chunked, full)
	}
}

// TestTokenRangesCoverInput verifies tokens are ordered, non-overlapping
// and that every byte of the input is either inside a token or is
// inter-expression whitespace skipped by the lexer.
func TestTokenRangesOrdered(t *testing.T) {
	src := []byte(`a {{ b("c", (1)) }} d {{ e }}`)
	toks, err := Lex(src)
	if err != nil {
		t.Fatalf("Lex: %v", err)
	}
	prev := 0
	for _, tok := range toks {
		if tok.Start < prev {
			t.Fatalf("token %v overlaps previous (prev end %d)", tok, prev)
		}
		for i := prev; i < tok.Start; i++ {
			if !isSpace(src[i]) {
				t.Fatalf("byte %d (%q) not covered by any token", i, src[i])
			}
		}
		prev = tok.End
	}
	for i := prev; i < len(src); i++ {
		if !isSpace(src[i]) {
			t.Fatalf("trailing byte %d (%q) not covered by any token", i, src[i])
		}
	}
}
