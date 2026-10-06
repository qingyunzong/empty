package norm

import (
	"errors"
	"strings"
	"testing"
)

func TestNormalizeBasic(t *testing.T) {
	src := `// leading comment
{
  "b": [1, 2, 3,],   // trailing comma in array
  "a": { "z": null, "y": true, },
  /* block comment */ "num": 1.50e1,
  "s": "x\nAé",
}`
	want := `{"a":{"y":true,"z":null},"b":[1,2,3],"num":15,"s":"x\nAé"}`
	if got := mustNormalize(t, src, 1<<30); got != want {
		t.Errorf("got  %s\nwant %s", got, want)
	}
}

func TestKeySortUTF8ByteOrder(t *testing.T) {
	src := `{"é":1,"a":2,"Z":3,"中":4,"_":5,"aa":6,"aA":7}`
	want := `{"Z":3,"_":5,"a":2,"aA":7,"aa":6,"é":1,"中":4}`
	if got := mustNormalize(t, src, 1<<30); got != want {
		t.Errorf("got  %s\nwant %s", got, want)
	}
}

func TestDuplicateKeyRejected(t *testing.T) {
	_, err := normalizeToString(t, `{"a":1,"b":2,"a":3}`, 1<<30)
	if err == nil || !strings.Contains(err.Error(), `duplicate key "a"`) {
		t.Fatalf("want duplicate key error, got %v", err)
	}
	var perr *Error
	if !errors.As(err, &perr) {
		t.Fatalf("error is %T, want *Error", err)
	}
	start, _ := perr.Span()
	if start != 13 { // offset of the opening quote of the second "a"
		t.Errorf("duplicate key span start = %d, want 13", start)
	}
}

func TestDuplicateKeyEscapedForms(t *testing.T) {
	// "A" and "A" decode to the same key.
	if _, err := normalizeToString(t, `{"A":1,"A":2}`, 1<<30); err == nil {
		t.Fatal("want duplicate key error for escaped key forms")
	}
}

func TestTopLevelValues(t *testing.T) {
	cases := map[string]string{
		`42`:               `42`,
		`  -1.5e3  `:       `-1500`,
		`"hi"`:             `"hi"`,
		`true`:             `true`,
		`null // done`:     `null`,
		`[1, [2, [3,],],]`: `[1,[2,[3]]]`,
		`{}`:               `{}`,
		`[ ]`:              `[]`,
	}
	for src, want := range cases {
		if got := mustNormalize(t, src, 1<<30); got != want {
			t.Errorf("normalize(%q) = %q, want %q", src, got, want)
		}
	}
}

func TestParseErrors(t *testing.T) {
	cases := []struct {
		src  string
		want string
	}{
		{``, "unexpected end of input"},
		{`   `, "unexpected end of input"},
		{`{`, "unexpected end of input"},
		{`{"a" 1}`, "expected ':'"},
		{`{"a":1 "b":2}`, "expected ',' or '}'"},
		{`[1 2]`, "expected ',' or ']'"},
		{`{"a":01}`, "invalid number"},
		{`{"a":1.}`, "invalid number"},
		{`{"a":tru}`, "invalid literal"},
		{`{"a":truex}`, "invalid literal"},
		{`{"a":"\uD800"}`, "lone high surrogate"},
		{`{"a":"\uDC00"}`, "lone low surrogate"},
		{`{"a":"\x"}`, "invalid escape"},
		{"{\"a\":\"\x01\"}", "unescaped control character"},
		{`/* never closed`, "unterminated block comment"},
		{`{} {}`, "trailing data"},
		{`{,}`, "expected string key"},
		{`{"a":"` + "\xff" + `"}`, "invalid UTF-8"},
		{`{"a":"unterminated`, "unterminated string"},
		{`nul`, "invalid literal"},
	}
	for _, c := range cases {
		_, err := normalizeToString(t, c.src, 1<<30)
		if err == nil {
			t.Errorf("normalize(%q): want error containing %q, got nil", c.src, c.want)
			continue
		}
		if !strings.Contains(err.Error(), c.want) {
			t.Errorf("normalize(%q): error %q does not contain %q", c.src, err, c.want)
		}
	}
}

func TestErrorSpanLineCol(t *testing.T) {
	_, err := normalizeToString(t, "{\n  \"a\": 1,\n  bad\n}", 1<<30)
	if err == nil {
		t.Fatal("want error")
	}
	if !strings.Contains(err.Error(), "line 3, column 3") {
		t.Errorf("error %q does not report line 3, column 3", err)
	}
}

func TestCommentsInsideStrings(t *testing.T) {
	src := `{"url": "http://example.com/*not-comment*/", "x": 1}`
	want := `{"url":"http://example.com/*not-comment*/","x":1}`
	if got := mustNormalize(t, src, 1<<30); got != want {
		t.Errorf("got  %s\nwant %s", got, want)
	}
}

func TestStringEscapesRoundTrip(t *testing.T) {
	src := `{"s": "\"\\\/\b\f\n\r\t\u0000\u001f\u2028\u2029é中😀"}`
	want := `{"s":"\"\\/\u0008\u000c\n\r\t\u0000\u001f\u2028\u2029é中😀"}`
	if got := mustNormalize(t, src, 1<<30); got != want {
		t.Errorf("got  %s\nwant %s", got, want)
	}
}
