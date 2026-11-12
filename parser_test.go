package dataeng

import (
	"bytes"
	"errors"
	"math/big"
	"testing"
)

func TestDuplicateNestedKeysAndQueries(t *testing.T) {
	input := []byte(`{"a":1,"a":{"b":2,"b":3},"a":[10,null],"c":null}`)
	p, err := Parse(input)
	if err != nil {
		t.Fatalf("parse: %v", err)
	}
	root := p.Root()
	if got := len(root.Members); got != 4 {
		t.Fatalf("member count = %d, want 4 (duplicates retained)", got)
	}
	if root.Members[0].Key != "a" || root.Members[3].Key != "c" {
		t.Fatalf("key order not preserved: %+v", root.Members)
	}

	// nth occurrence selector, 1-based.
	first := root.Query(FieldStep("a", 1))
	if !first.Found || first.Node.Kind != KindNumber || first.Node.Num.Lexeme() != "1" {
		t.Fatalf("a[1] wrong: %+v", first)
	}
	second := root.Query(FieldStep("a", 2), FieldStep("b", 2))
	if !second.Found || second.Node.Num.Lexeme() != "3" {
		t.Fatalf("a[2].b[2] wrong: %+v", second)
	}

	// all occurrences, including nested duplicate expansion.
	all := root.Query(FieldStep("a", AllOccurrences))
	if len(all.All) != 3 {
		t.Fatalf("all a occurrences = %d, want 3", len(all.All))
	}
	nestedAll := root.Query(FieldStep("a", 2), FieldStep("b", AllOccurrences))
	if len(nestedAll.All) != 2 || nestedAll.All[0].Num.Lexeme() != "2" || nestedAll.All[1].Num.Lexeme() != "3" {
		t.Fatalf("nested b occurrences wrong: %+v", nestedAll.All)
	}

	// zero-based array index, including an explicit null element.
	nullElem := root.Query(FieldStep("a", 3), IndexStep(1))
	if !nullElem.Found || nullElem.Node.Kind != KindNull {
		t.Fatalf("array null element wrong: %+v", nullElem)
	}
	outOfRange := root.Query(FieldStep("a", 3), IndexStep(9))
	if outOfRange.Found {
		t.Fatalf("out-of-range index must be missing")
	}

	// missing field vs explicit null are distinct.
	missing := root.Query(FieldStep("absent", 1))
	if missing.Found || !missing.IsMissing() || missing.Node != nil {
		t.Fatalf("absent field must be missing, got %+v", missing)
	}
	explicitNull := root.Query(FieldStep("c", 1))
	if !explicitNull.Found || explicitNull.Node.Kind != KindNull {
		t.Fatalf("explicit null must be found as KindNull")
	}

	// occurrence beyond the duplicate count is missing, not null.
	fifthA := root.Query(FieldStep("a", 9))
	if fifthA.Found {
		t.Fatalf("a[9] must be missing")
	}
}

func TestIndependentQueryModel(t *testing.T) {
	root := &Node{
		Kind: KindObject,
		Members: []Member{
			{Key: "k", Value: &Node{Kind: KindArray,
				Elems: []*Node{{Kind: KindString, Str: "x"}}}},
		},
	}
	res := QueryPath(root, FieldStep("k", 1), IndexStep(0))
	if !res.Found || res.Node.Str != "x" {
		t.Fatalf("independent query failed: %+v", res)
	}
}

func TestByteByByteStreamingMatchesOneShot(t *testing.T) {
	cases := []string{
		`{"a":1,"a":[2,3],"b":{"c":"x\u00e9","d":null}}`,
		`[1, 2.5, -3.25e2, true, false, null, "esc\ntab\tend"]`,
		`{"emoji":"😀","pair":"\uD83D\uDE00","deep":{"deep2":[1,2,{"z":9}]}}`,
		`{"k":"v"}{"second":1}[1,2]`,
	}
	for idx, tc := range cases {
		one, err := Parse([]byte(tc))
		if err != nil {
			t.Fatalf("case %d one-shot: %v", idx, err)
		}
		want, err := Encode(one.Root())
		if err != nil {
			t.Fatalf("case %d encode: %v", idx, err)
		}

		p := NewParser()
		for i := 0; i < len(tc); i++ {
			if err := p.Feed([]byte{tc[i]}); err != nil {
				t.Fatalf("case %d byte %d (%q): %v", idx, i, tc[i], err)
			}
		}
		if err := p.End(); err != nil {
			t.Fatalf("case %d end: %v", idx, err)
		}
		got, err := Encode(p.Root())
		if err != nil {
			t.Fatalf("case %d stream encode: %v", idx, err)
		}
		if !bytes.Equal(got, want) {
			t.Fatalf("case %d mismatch\n got %s\nwant %s", idx, got, want)
		}
	}
}

func TestObjectStreamMultipleRoots(t *testing.T) {
	p := NewParser()
	chunks := []string{`{"id":1} `, ` {"id":2,"id":2}`, ` [true]`}
	for _, c := range chunks {
		if err := p.Feed([]byte(c)); err != nil {
			t.Fatalf("feed %q: %v", c, err)
		}
	}
	if err := p.End(); err != nil {
		t.Fatalf("end: %v", err)
	}
	roots := p.Roots()
	if len(roots) != 3 {
		t.Fatalf("roots = %d, want 3", len(roots))
	}
	if len(roots[1].Members) != 2 {
		t.Fatalf("duplicate key in streamed root not retained")
	}
	if roots[2].Elems[0].Bool != true {
		t.Fatalf("array root wrong")
	}
}

func TestTrailingTruncationRejected(t *testing.T) {
	cases := []string{
		`{"a":1`,
		`{"a":`,
		`{"a":"unterminated`,
		`{"a":"escape\u004`,
		`{"a":"surrogate\uD83D`,
		`{"a":"surrogate2\uD83D\`,
		`[1, 2,`,
		`12345.`,
		`1.2e`,
		`-`,
		`tru`,
		`{"a":1} {"b":`,
	}
	for idx, tc := range cases {
		p := NewParser()
		var feedErr error
		for i := 0; i < len(tc); i++ {
			if err := p.Feed([]byte{tc[i]}); err != nil {
				feedErr = err
				break
			}
		}
		err := feedErr
		if err == nil {
			err = p.End()
		}
		if err == nil {
			t.Fatalf("case %d %q: expected error for truncated input", idx, tc)
		}
	}

	// Truncation mid-run across chunk boundaries must still be caught at End.
	p := NewParser()
	if err := p.Feed([]byte(`{"a":"x`)); err != nil {
		t.Fatalf("feed: %v", err)
	}
	if err := p.End(); !errors.Is(err, ErrIncomplete) {
		t.Fatalf("truncated string end err = %v, want ErrIncomplete", err)
	}
}

func TestEmptyAndSyntaxRejected(t *testing.T) {
	if _, err := Parse(nil); !errors.Is(err, ErrEmptyStream) {
		t.Fatalf("empty input err = %v, want ErrEmptyStream", err)
	}
	bad := []string{
		`{,}`, `{"a" 1}`, `[1,]`, `01`, `1.`, `1e`, `truE`, `nul`,
		`{"a":01}`, `[1 2]`, `.5`, `{"a":1,}`, `[,1]`, `{"a" "b"}`, `--1`, `1..2`,
	}
	for _, tc := range bad {
		if _, err := Parse([]byte(tc)); err == nil {
			t.Fatalf("invalid JSON %q accepted", tc)
		}
	}
}

func TestTopLevelScalarStream(t *testing.T) {
	p, err := Parse([]byte(`1 "two" true false null`))
	if err != nil {
		t.Fatalf("scalar stream: %v", err)
	}
	roots := p.Roots()
	if len(roots) != 5 {
		t.Fatalf("scalar roots = %d, want 5", len(roots))
	}
	if roots[0].Num.Lexeme() != "1" || roots[1].Str != "two" || roots[4].Kind != KindNull {
		t.Fatalf("scalar stream values wrong: %+v", roots)
	}
}

func TestNumberLexemeAndExactRat(t *testing.T) {
	cases := map[string]string{
		"1":                "1/1",
		"1.50":             "3/2",
		"-0.25":            "-1/4",
		"1e3":              "1000/1",
		"2.5E-2":           "1/40",
		"100":              "100/1",
		"0.0001":           "1/10000",
		"-1.25e2":          "-125/1",
		"9007199254740993": "9007199254740993/1",
	}
	for lex, wantRat := range cases {
		p, err := Parse([]byte(lex))
		if err != nil {
			t.Fatalf("parse %q: %v", lex, err)
		}
		num := p.Root().Num
		if num.Lexeme() != lex {
			t.Fatalf("lexeme = %q, want %q", num.Lexeme(), lex)
		}
		if got := num.Rat().String(); got != wantRat {
			t.Fatalf("%q rat = %s, want %s", lex, got, wantRat)
		}
		want, _ := new(big.Rat).SetString(wantRat)
		if num.Rat().Cmp(want) != 0 {
			t.Fatalf("%q rat mismatch", lex)
		}
	}
}

func TestSignificantDigitBudget(t *testing.T) {
	within := "1." + repeatDigits(9)  // 10 significant digits total
	atLimit := "1." + repeatDigits(9) // exactly 10
	over := "12." + repeatDigits(10)  // 12 significant digits
	budget := WithBudget(Budget{MaxSignificantDigits: 10, MaxExponentExpansion: 0})

	if _, err := Parse([]byte(within), budget); err != nil {
		t.Fatalf("within budget rejected: %v", err)
	}
	if _, err := Parse([]byte(atLimit), budget); err != nil {
		t.Fatalf("at-limit value rejected: %v", err)
	}
	_, err := Parse([]byte(over), budget)
	if !errors.Is(err, ErrSignificantDigitsExceeded) {
		t.Fatalf("over budget err = %v, want ErrSignificantDigitsExceeded", err)
	}

	// Leading zeros do not count; trailing zeros do.
	if _, err := Parse([]byte("0.0001234567890"), budget); err != nil {
		t.Fatalf("leading-zero value rejected: %v", err)
	}
	if _, err := Parse([]byte("12345678901"), budget); !errors.Is(err, ErrSignificantDigitsExceeded) {
		t.Fatalf("11-digit integer err = %v", err)
	}
}

func TestExponentExpansionBudget(t *testing.T) {
	budget := func(exp int) Option {
		return WithBudget(Budget{MaxSignificantDigits: 0, MaxExponentExpansion: exp})
	}

	// Effective exponent of 1.5e3 is 2 (digits 15, decimal point after 1 digit).
	if _, err := Parse([]byte("1.5e3"), budget(2)); err != nil {
		t.Fatalf("at-limit exponent rejected: %v", err)
	}
	if _, err := Parse([]byte("1.5e4"), budget(2)); !errors.Is(err, ErrExponentBudgetExceeded) {
		t.Fatalf("positive over-budget err = %v", err)
	}
	if _, err := Parse([]byte("1.5e-3"), budget(2)); !errors.Is(err, ErrExponentBudgetExceeded) {
		t.Fatalf("negative over-budget err = %v", err)
	}
	// Fractional-only number: effective exponent of 0.001 is -3.
	if _, err := Parse([]byte("0.001"), budget(3)); err != nil {
		t.Fatalf("fractional at-limit rejected: %v", err)
	}
}

func TestHugeExponentRejectedBounded(t *testing.T) {
	// A pathological exponent must be refused before any big.Int expansion.
	p := NewParser(WithBudget(Budget{MaxSignificantDigits: 0, MaxExponentExpansion: 100000}))
	huge := "1e999999999999999999999999999999"
	if err := p.Feed([]byte(huge)); err != nil {
		t.Fatalf("feed should buffer the number, got %v", err)
	}
	if err := p.End(); !errors.Is(err, ErrExponentBudgetExceeded) {
		t.Fatalf("huge exponent err = %v, want ErrExponentBudgetExceeded", err)
	}
	// The parser must stay inert and hold the first error.
	if err := p.Feed([]byte(" ")); !errors.Is(err, ErrExponentBudgetExceeded) {
		t.Fatalf("parser not inert after error: %v", err)
	}
}

func repeatDigits(n int) string {
	b := make([]byte, n)
	for i := range b {
		b[i] = '9'
	}
	return string(b)
}

func TestStringUTF8AndSurrogates(t *testing.T) {
	good := map[string]string{
		`"hello"`:               "hello",
		`"\u0041\u0042"`:        "AB",
		`"\uD83D\uDE00"`:        "😀",
		`"caf\u00e9"`:           "café",
		`"esc\\quote\"slash\/"`: `esc\quote"slash/`,
		`"\u00e9"`:              "é",
	}
	for raw, want := range good {
		p, err := Parse([]byte(raw))
		if err != nil {
			t.Fatalf("valid string %q rejected: %v", raw, err)
		}
		if got := p.Root().Str; got != want {
			t.Fatalf("%q decoded = %q, want %q", raw, got, want)
		}
	}

	bad := []string{
		`"\uD83D"`,                 // high surrogate alone
		`"\uDC00"`,                 // low surrogate alone
		`"\uD83D\u0041"`,           // high followed by non-surrogate
		`"\uD83D\uE000"`,           // high followed by non-low
		`"raw` + "\x00" + `ctrl"`,  // raw NUL
		`"tab` + "\t" + `"`,        // raw tab
		`"\q"`,                     // bad escape
		`"\u12"`,                   // truncated escape
		`"` + "\xff" + `"`,         // invalid UTF-8 lead
		`"` + "\xc3" + `"`,         // truncated two-byte sequence
		`"` + "\xc3\x28" + `"`,     // invalid continuation
		`"` + "\xed\xa0\x80" + `"`, // raw encoded U+D800
	}
	for _, raw := range bad {
		if _, err := Parse([]byte(raw)); err == nil {
			t.Fatalf("invalid string %q accepted", raw)
		}
	}
}

func TestMultibyteSpanningChunks(t *testing.T) {
	raw := []byte(`{"k":"é😀"}`)
	for split := 1; split < len(raw); split++ {
		p := NewParser()
		if err := p.Feed(raw[:split]); err != nil {
			t.Fatalf("split %d first feed: %v", split, err)
		}
		if err := p.Feed(raw[split:]); err != nil {
			t.Fatalf("split %d second feed: %v", split, err)
		}
		if err := p.End(); err != nil {
			t.Fatalf("split %d end: %v", split, err)
		}
		if got := p.Root().Members[0].Value.Str; got != "é😀" {
			t.Fatalf("split %d decoded = %q", split, got)
		}
	}
}

func TestReencodePreservesOrderDuplicatesAndLexemes(t *testing.T) {
	raw := `{"z":1.50,"a":-0.25e2,"z":[100,0.0001],"z":{"n":9007199254740993},"empty":{},"arr":[]}`
	p, err := Parse([]byte(raw))
	if err != nil {
		t.Fatalf("parse: %v", err)
	}
	out, err := Encode(p.Root())
	if err != nil {
		t.Fatalf("encode: %v", err)
	}
	// Compact re-encoding keeps every number lexeme and duplicate key.
	want := `{"z":1.50,"a":-0.25e2,"z":[100,0.0001],"z":{"n":9007199254740993},"empty":{},"arr":[]}`
	if string(out) != want {
		t.Fatalf("compact encode =\n%s\nwant\n%s", out, want)
	}

	indented, err := EncodeIndented(p.Root(), "  ")
	if err != nil {
		t.Fatalf("indent encode: %v", err)
	}
	// Whitespace may change, but token content must stay identical.
	reparsed, err := Parse(indented)
	if err != nil {
		t.Fatalf("reparse indented: %v", err)
	}
	again, err := Encode(reparsed.Root())
	if err != nil {
		t.Fatalf("re-encode: %v", err)
	}
	if string(again) != want {
		t.Fatalf("indented round-trip changed content:\n%s", again)
	}
	if len(reparsed.Root().Members) != 6 {
		t.Fatalf("duplicate keys lost during indented round-trip")
	}
}
