package lexer

import (
	"math/rand"
	"reflect"
	"testing"
)

func tok(k TokenKind, pos, end int, text string) Token {
	return Token{Kind: k, Pos: pos, End: end, Text: text}
}

// TestOneShot pins down exact tokens, errors and byte positions.
func TestOneShot(t *testing.T) {
	cases := []struct {
		name   string
		input  string
		tokens []Token
		errs   []Error
	}{
		{
			name:  "empty",
			input: "",
		},
		{
			name:  "idents numbers punct",
			input: "foo bar_2 12 3.5 +",
			tokens: []Token{
				tok(TokIdent, 0, 3, "foo"),
				tok(TokIdent, 4, 9, "bar_2"),
				tok(TokNumber, 10, 12, "12"),
				tok(TokNumber, 13, 16, "3.5"),
				tok(TokPunct, 17, 18, "+"),
			},
		},
		{
			name:  "number dot not fraction",
			input: "1.x",
			tokens: []Token{
				tok(TokNumber, 0, 1, "1"),
				tok(TokPunct, 1, 2, "."),
				tok(TokIdent, 2, 3, "x"),
			},
		},
		{
			name:  "string with escapes",
			input: `"a\"b\\c" x`,
			tokens: []Token{
				tok(TokString, 0, 9, `"a\"b\\c"`),
				tok(TokIdent, 10, 11, "x"),
			},
		},
		{
			name:  "empty string",
			input: `""`,
			tokens: []Token{
				tok(TokString, 0, 2, `""`),
			},
		},
		{
			name:  "unterminated string at eof",
			input: `x "abc`,
			tokens: []Token{
				tok(TokIdent, 0, 1, "x"),
			},
			errs: []Error{{Kind: ErrUnterminatedString, Pos: 2, End: 6}},
		},
		{
			name:  "unterminated string trailing backslash",
			input: `"ab\`,
			errs:  []Error{{Kind: ErrUnterminatedString, Pos: 0, End: 4}},
		},
		{
			name:  "unterminated string at newline",
			input: "\"ab\ncd",
			tokens: []Token{
				tok(TokIdent, 4, 6, "cd"),
			},
			errs: []Error{{Kind: ErrUnterminatedString, Pos: 0, End: 3}},
		},
		{
			name:  "line comment",
			input: "// hi\nx",
			tokens: []Token{
				tok(TokLineComment, 0, 5, "// hi"),
				tok(TokIdent, 6, 7, "x"),
			},
		},
		{
			name:  "line comment ends at eof",
			input: "// hi",
			tokens: []Token{
				tok(TokLineComment, 0, 5, "// hi"),
			},
		},
		{
			name:  "block comment simple",
			input: "/* a */b",
			tokens: []Token{
				tok(TokBlockComment, 0, 7, "/* a */"),
				tok(TokIdent, 7, 8, "b"),
			},
		},
		{
			name:  "block comment nested",
			input: "/* a /* b */ c */d",
			tokens: []Token{
				tok(TokBlockComment, 0, 17, "/* a /* b */ c */"),
				tok(TokIdent, 17, 18, "d"),
			},
		},
		{
			name:  "nested closers balance",
			input: "/*/**/*/",
			tokens: []Token{
				tok(TokBlockComment, 0, 8, "/*/**/*/"),
			},
		},
		{
			name:  "unterminated block comment depth1",
			input: "/* abc",
			errs:  []Error{{Kind: ErrUnterminatedComment, Pos: 0, End: 6}},
		},
		{
			name:  "unterminated nested block comment",
			input: "/* a /* b */ c",
			errs:  []Error{{Kind: ErrUnterminatedComment, Pos: 0, End: 14}},
		},
		{
			name:  "unterminated comment ends with star",
			input: "/* ab*",
			errs:  []Error{{Kind: ErrUnterminatedComment, Pos: 0, End: 6}},
		},
		{
			name:  "comment markers inside string",
			input: `"/* // */"`,
			tokens: []Token{
				tok(TokString, 0, 10, `"/* // */"`),
			},
		},
		{
			name:  "quote inside line comment",
			input: "// \"\nx",
			tokens: []Token{
				tok(TokLineComment, 0, 4, "// \""),
				tok(TokIdent, 5, 6, "x"),
			},
		},
		{
			name:  "line comment inside block comment",
			input: "/* // \" */x",
			tokens: []Token{
				tok(TokBlockComment, 0, 10, "/* // \" */"),
				tok(TokIdent, 10, 11, "x"),
			},
		},
		{
			name:  "block open inside line comment",
			input: "// /*\nx",
			tokens: []Token{
				tok(TokLineComment, 0, 5, "// /*"),
				tok(TokIdent, 6, 7, "x"),
			},
		},
		{
			name:  "lone slash at eof",
			input: "a/",
			tokens: []Token{
				tok(TokIdent, 0, 1, "a"),
				tok(TokPunct, 1, 2, "/"),
			},
		},
		{
			name:  "slash star slash is unterminated",
			input: "/*/",
			errs:  []Error{{Kind: ErrUnterminatedComment, Pos: 0, End: 3}},
		},
		{
			name:  "invalid char",
			input: "a\x01b",
			tokens: []Token{
				tok(TokIdent, 0, 1, "a"),
				tok(TokIdent, 2, 3, "b"),
			},
			errs: []Error{{Kind: ErrInvalidChar, Pos: 1, End: 2}},
		},
		{
			name:  "error then recovery",
			input: "\"bad\nok /* done",
			tokens: []Token{
				tok(TokIdent, 5, 7, "ok"),
			},
			errs: []Error{
				{Kind: ErrUnterminatedString, Pos: 0, End: 4},
				{Kind: ErrUnterminatedComment, Pos: 8, End: 15},
			},
		},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			tokens, errs := Lex([]byte(tc.input))
			if !reflect.DeepEqual(tokens, tc.tokens) {
				t.Errorf("tokens:\n got %+v\nwant %+v", tokens, tc.tokens)
			}
			if !reflect.DeepEqual(errs, tc.errs) {
				t.Errorf("errors:\n got %+v\nwant %+v", errs, tc.errs)
			}
		})
	}
}

// chunkInputs are inputs exercised under exhaustive chunk splitting.
var chunkInputs = []string{
	"",
	"a",
	"/",
	"//",
	"//x",
	"//x\ny",
	"/**/",
	"/*/",
	"/*a*/",
	"/*/*/*/",
	"/*/*/**/*/",
	"/* a /* b */ c */ z",
	"/* unterminated",
	"/* nested /* still open */",
	`""`,
	`"a"`,
	`"a\"b"`,
	`"a\`,
	`"abc`,
	"\"ab\ncd\"",
	`"/* not comment */"`,
	"foo 12 3.5 bar_2",
	"1. 2.x 3.14",
	"a//b\nc/*d*/e",
	"/*//*/x",
	"// /*\nx",
	"a/b/c",
	"x = y + 1; // sum\n/* doc */ f(\"s\\t\")",
	"\"bad\nok /* done",
	"a\x01b",
	"\t \r\n",
}

// lexChunked feeds data in the given chunks and closes.
func lexChunked(data []byte, cuts ...int) ([]Token, []Error) {
	l := New()
	prev := 0
	for _, c := range cuts {
		l.Feed(data[prev:c])
		prev = c
	}
	l.Feed(data[prev:])
	l.Close()
	return l.Tokens(), l.Errors()
}

func checkSame(t *testing.T, input string, wantTok []Token, wantErr []Error, cuts ...int) {
	t.Helper()
	tokens, errs := lexChunked([]byte(input), cuts...)
	if !reflect.DeepEqual(tokens, wantTok) {
		t.Errorf("input %q cuts %v: tokens:\n got %+v\nwant %+v", input, cuts, tokens, wantTok)
	}
	if !reflect.DeepEqual(errs, wantErr) {
		t.Errorf("input %q cuts %v: errors:\n got %+v\nwant %+v", input, cuts, errs, wantErr)
	}
}

// TestAllTwoChunks splits every input at every possible point.
func TestAllTwoChunks(t *testing.T) {
	for _, input := range chunkInputs {
		wantTok, wantErr := Lex([]byte(input))
		for i := 0; i <= len(input); i++ {
			checkSame(t, input, wantTok, wantErr, i)
		}
	}
}

// TestAllThreeChunks tries every pair of cut points.
func TestAllThreeChunks(t *testing.T) {
	for _, input := range chunkInputs {
		wantTok, wantErr := Lex([]byte(input))
		for i := 0; i <= len(input); i++ {
			for j := i; j <= len(input); j++ {
				checkSame(t, input, wantTok, wantErr, i, j)
			}
		}
	}
}

// TestByteByByte feeds every input one byte at a time.
func TestByteByByte(t *testing.T) {
	for _, input := range chunkInputs {
		wantTok, wantErr := Lex([]byte(input))
		cuts := make([]int, 0, len(input))
		for i := 1; i < len(input); i++ {
			cuts = append(cuts, i)
		}
		checkSame(t, input, wantTok, wantErr, cuts...)
	}
}

// TestRandomChunking feeds random inputs in random chunkings.
func TestRandomChunking(t *testing.T) {
	rng := rand.New(rand.NewSource(1))
	alphabet := []byte(`abc_019. "/\*` + "\n\t" + `\`)
	for trial := 0; trial < 2000; trial++ {
		n := rng.Intn(40)
		data := make([]byte, n)
		for i := range data {
			data[i] = alphabet[rng.Intn(len(alphabet))]
		}
		wantTok, wantErr := Lex(data)
		var cuts []int
		for pos := 0; pos < n; {
			pos += rng.Intn(5)
			if pos < n {
				cuts = append(cuts, pos)
			}
		}
		tokens, errs := lexChunked(data, cuts...)
		if !reflect.DeepEqual(tokens, wantTok) {
			t.Fatalf("trial %d input %q cuts %v: tokens:\n got %+v\nwant %+v", trial, data, cuts, tokens, wantTok)
		}
		if !reflect.DeepEqual(errs, wantErr) {
			t.Fatalf("trial %d input %q cuts %v: errors:\n got %+v\nwant %+v", trial, data, cuts, errs, wantErr)
		}
	}
}

// TestPositionsAreByteOffsets verifies Pos/End are raw byte offsets and
// that concatenating token coverage matches expectations.
func TestPositionsAreByteOffsets(t *testing.T) {
	input := "ab /* x /* y */ z */ \"q\\\"\" 9.25 // tail"
	tokens, errs := Lex([]byte(input))
	if len(errs) != 0 {
		t.Fatalf("unexpected errors: %+v", errs)
	}
	for _, tk := range tokens {
		if input[tk.Pos:tk.End] != tk.Text {
			t.Errorf("token %+v: Text does not match input[Pos:End]", tk)
		}
	}
}
