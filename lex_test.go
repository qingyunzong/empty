package bracketdiag

import "testing"

func TestLexIgnoresStringsAndComments(t *testing.T) {
	cases := []struct {
		name string
		text string
		want []Token // 期望的括号 token（绝对偏移）
	}{
		{"plain", "a(b)c", []Token{{1, true, Paren}, {3, false, Paren}}},
		{"string", `a("(")b`, []Token{{1, true, Paren}, {5, false, Paren}}},
		{"escaped quote", `a("\"" ( )`, []Token{{1, true, Paren}, {7, true, Paren}, {9, false, Paren}}},
		{"char", `a('(') (`, []Token{{1, true, Paren}, {5, false, Paren}, {7, true, Paren}}},
		{"line comment", "a( // ))\nb)", []Token{{1, true, Paren}, {10, false, Paren}}},
		{"block comment", "a( /* ) ( */ )", []Token{{1, true, Paren}, {13, false, Paren}}},
		{"block comment multiline", "a( /* )\n( */ )", []Token{{1, true, Paren}, {13, false, Paren}}},
		{"raw string", "a( `)\n(` )", []Token{{1, true, Paren}, {9, false, Paren}}},
		{"unterminated string recovers at eol", "a( \" )\nb )", []Token{{1, true, Paren}, {9, false, Paren}}},
		{"unterminated block comment swallows rest", "a( /* \n) (", []Token{{1, true, Paren}}},
		{"all kinds", "([{ }])", []Token{
			{0, true, Paren}, {1, true, Square}, {2, true, Brace},
			{4, false, Brace}, {5, false, Square}, {6, false, Paren},
		}},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			var got []Token
			st := StateNormal
			off := 0
			for _, ln := range splitLines(c.text) {
				lt, end := lexLine(ln, st)
				for _, tok := range lt {
					tok.Pos += off
					got = append(got, tok)
				}
				st = end
				off += len(ln) + 1
			}
			if len(got) != len(c.want) {
				t.Fatalf("got %d tokens %v, want %d %v", len(got), got, len(c.want), c.want)
			}
			for i := range got {
				if got[i] != c.want[i] {
					t.Fatalf("token %d: got %+v, want %+v", i, got[i], c.want[i])
				}
			}
		})
	}
}

func TestAnalyzeMatching(t *testing.T) {
	d := Analyze("f(a[0])")
	if len(d.Pairs) != 2 || d.EarliestError != -1 {
		t.Fatalf("unexpected: %+v", d)
	}
	if d.Pairs[0] != (Pair{Open: 3, Close: 5}) || d.Pairs[1] != (Pair{Open: 1, Close: 6}) {
		t.Fatalf("pairs: %+v", d.Pairs)
	}

	// "([)]"：')' 在位置 2 与栈顶 '[' 不匹配 → 最早错误为 2；
	// '[' 与 ']' 仍配对，'(' 未闭合。
	d = Analyze("([)]")
	if d.EarliestError != 2 {
		t.Fatalf("earliest: got %d, want 2 (%+v)", d.EarliestError, d)
	}
	if len(d.UnmatchedCloses) != 1 || d.UnmatchedCloses[0] != 2 {
		t.Fatalf("unmatched closes: %+v", d.UnmatchedCloses)
	}
	if len(d.UnmatchedOpens) != 1 || d.UnmatchedOpens[0] != 0 {
		t.Fatalf("unmatched opens: %+v", d.UnmatchedOpens)
	}
	if len(d.Pairs) != 1 || d.Pairs[0] != (Pair{Open: 1, Close: 3}) {
		t.Fatalf("pairs: %+v", d.Pairs)
	}

	d = Analyze("((x")
	if d.EarliestError != 0 || len(d.UnmatchedOpens) != 2 {
		t.Fatalf("unclosed opens: %+v", d)
	}
}
