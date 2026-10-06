package addrlist

import (
	"fmt"
	"math/rand"
	"reflect"
	"testing"
)

func addrs(texts ...string) []Address {
	var out []Address
	for _, t := range texts {
		out = append(out, Address{Text: t})
	}
	return out
}

func texts(got []Address) []string {
	var out []string
	for _, a := range got {
		out = append(out, a.Text)
	}
	return out
}

func checkTexts(t *testing.T, input string, want []string) {
	t.Helper()
	got := texts(Parse(input))
	if !reflect.DeepEqual(got, want) {
		t.Errorf("Parse(%q) texts = %q, want %q", input, got, want)
	}
}

func TestBasicSplit(t *testing.T) {
	checkTexts(t, `a@x, b@y ,c@z`, []string{"a@x", "b@y", "c@z"})
}

func TestEmptyAddressesSkipped(t *testing.T) {
	checkTexts(t, ` , a@x,, ,b@y, `, []string{"a@x", "b@y"})
	checkTexts(t, ``, nil)
	checkTexts(t, ` , ,`, nil)
}

func TestCommentRemoval(t *testing.T) {
	checkTexts(t, `alice(comment)@x, (lead) bob@y (trail)`, []string{"alice@x", "bob@y"})
	checkTexts(t, `(only a comment)`, nil)
}

func TestNestedComments(t *testing.T) {
	checkTexts(t, `a(one(two(three))still comment)@x`, []string{"a@x"})
	// A paren inside a comment does not end it early.
	checkTexts(t, `a(b(c)d)e@x, f@y`, []string{"ae@x", "f@y"})
}

func TestCommentEscape(t *testing.T) {
	// \) is literal inside a comment and does not close it.
	checkTexts(t, `a(esc \) still comment)@x`, []string{"a@x"})
	// Unclosed comment runs to end of input.
	checkTexts(t, `a@x (never closed, b@y`, []string{"a@x"})
}

func TestQuotedComma(t *testing.T) {
	checkTexts(t, `"Doe, John" <john@x>, jane@y`, []string{`"Doe, John" <john@x>`, "jane@y"})
}

func TestQuoteEscape(t *testing.T) {
	// \" is a literal quote, does not end the quoted string.
	checkTexts(t, `"a\"b,c" <x@y>, z@w`, []string{`"a\"b,c" <x@y>`, "z@w"})
}

func TestTopLevelEscape(t *testing.T) {
	// Escaped comma at top level does not separate.
	checkTexts(t, `a\,b@x, c@y`, []string{`a\,b@x`, "c@y"})
	// Escaped quote does not open a quoted string.
	checkTexts(t, `a\"b,c@x`, []string{`a\"b`, "c@x"})
	// Escaped paren does not open a comment.
	checkTexts(t, `a\(b@x`, []string{`a\(b@x`})
}

func TestUnclosedQuoteIsolatedToLine(t *testing.T) {
	// The quote opens on line 1 and is implicitly closed by the
	// newline, so the comma on line 2 separates again.
	checkTexts(t, "\"unclosed, still one\nnext@x, last@y",
		[]string{"\"unclosed, still one\nnext@x", "last@y"})
	// Quote closed on the same line behaves normally.
	checkTexts(t, "\"a,b\"@x, c@y", []string{`"a,b"@x`, "c@y"})
	// Unclosed quote at EOF simply ends.
	checkTexts(t, `a@x, "tail`, []string{"a@x", `"tail`})
}

func TestNoDomainValidation(t *testing.T) {
	checkTexts(t, `not-an-address, !!!, "@"`, []string{"not-an-address", "!!!", `"@"`})
}

func TestSpans(t *testing.T) {
	input := `  a@x (note) , "b,c"@y  `
	got := Parse(input)
	want := []Address{
		{Text: "a@x", Start: 2, End: 5},
		{Text: `"b,c"@y`, Start: 15, End: 22},
	}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("Parse(%q) = %+v, want %+v", input, got, want)
	}
	// The span must slice the original input back out.
	for _, a := range got {
		if input[a.Start:a.End] != a.Text {
			t.Errorf("input[%d:%d] = %q, want %q", a.Start, a.End, input[a.Start:a.End], a.Text)
		}
	}
}

func TestSpanWithInteriorComment(t *testing.T) {
	input := `al(ice)@x, bob@y`
	got := Parse(input)
	want := []Address{
		{Text: "al@x", Start: 0, End: 9},
		{Text: "bob@y", Start: 11, End: 16},
	}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("Parse(%q) = %+v, want %+v", input, got, want)
	}
}

// parseChunked feeds input to the parser in chunks of n bytes.
func parseChunked(input string, n int) []Address {
	var out []Address
	p := NewParser(func(a Address) { out = append(out, a) })
	for i := 0; i < len(input); i += n {
		j := i + n
		if j > len(input) {
			j = len(input)
		}
		p.Write([]byte(input[i:j]))
	}
	p.Close()
	return out
}

var streamInputs = []string{
	`a@x, b@y, c@z`,
	`"Doe, John" <john@x>, jane(comment)@y`,
	`a(one(two(three))four)@x, "q\"u,ote" <z@w>`,
	"unclosed quote, comma\nsplit@x, esc\\,aped@y",
	`a\(not-a-comment@x, b\)also-not@c, (real comment)d@e`,
	"line1 \"broken\nline2, (unclosed comment never ends",
	"  \t spaced @ out , \n multi\nline @ addr ,",
	`\,,"\"",,(\(\)),`,
	"no separators at all",
	"",
	",,,",
}

func TestChunkedMatchesWhole(t *testing.T) {
	for _, input := range streamInputs {
		want := Parse(input)
		for _, n := range []int{1, 2, 3, 4, 5, 7, 11, 64, 4096} {
			got := parseChunked(input, n)
			if !reflect.DeepEqual(got, want) {
				t.Errorf("chunk size %d, input %q:\n got %+v\nwant %+v", n, input, got, want)
			}
		}
	}
}

func TestRandomChunkBoundaries(t *testing.T) {
	rng := rand.New(rand.NewSource(1))
	for _, input := range streamInputs {
		want := Parse(input)
		for trial := 0; trial < 20; trial++ {
			var out []Address
			p := NewParser(func(a Address) { out = append(out, a) })
			for i := 0; i < len(input); {
				n := 1 + rng.Intn(9)
				if i+n > len(input) {
					n = len(input) - i
				}
				p.Write([]byte(input[i : i+n]))
				i += n
			}
			p.Close()
			if !reflect.DeepEqual(out, want) {
				t.Fatalf("random chunks, input %q:\n got %+v\nwant %+v", input, out, want)
			}
		}
	}
}

func TestSpanInvariantAcrossInputs(t *testing.T) {
	// For every emitted address, the span must cover the address text
	// with comments removed: re-deriving Text from the span must yield
	// the same string.
	for _, input := range streamInputs {
		for _, a := range Parse(input) {
			span := input[a.Start:a.End]
			reparsed := Parse(span)
			if len(reparsed) != 1 || reparsed[0].Text != a.Text {
				t.Errorf("input %q: span %q reparsed to %+v, want single %q",
					input, span, reparsed, a.Text)
			}
		}
	}
}

func ExampleParse() {
	for _, a := range Parse(`"Doe, John" <john@x> (work), jane@y`) {
		fmt.Printf("[%d:%d] %s\n", a.Start, a.End, a.Text)
	}
	// Output:
	// [0:20] "Doe, John" <john@x>
	// [29:35] jane@y
}
